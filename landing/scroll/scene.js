/** aiLedger — the accumulating manifold. Original native WebGL, no dependencies. */
export function mountCollective(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false, powerPreference: 'low-power' });
  if (!gl) { canvas.dataset.renderState = 'unavailable'; return { setPaused() {}, setScroll() {}, destroy() {} }; }
  const vertex = `
  precision mediump float;
  attribute vec3 aPosition; attribute vec3 aNormal; attribute float aPath; attribute vec3 aRecord; attribute vec3 aHelix;
  uniform float uTime; uniform float uScroll; uniform float uAspect; uniform vec2 uPointer; uniform float uPoint;
  varying vec3 vNormal; varying vec3 vWorld; varying float vPath; varying float vDepth;
  mat3 rx(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
  mat3 ry(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
  mat3 rz(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
  void main(){
    float expand=smoothstep(0.,1.,uScroll)*(1.-smoothstep(1.,2.,uScroll));
    float record=smoothstep(1.,2.,uScroll)*(1.-smoothstep(2.,3.,uScroll));
    float helix=smoothstep(2.,3.,uScroll)*(1.-smoothstep(3.,4.,uScroll));
    vec3 form=aPosition*(1.+expand*.22);
    form=mix(form,aRecord,record);
    form=mix(form,aHelix,helix);
    float bank=mix(-.38,-.12,record+helix);
    mat3 r=rz(bank)*rx(.56+uPointer.y*.12-record*.37-helix*.35)*ry(.37+sin(uTime*.1)*.13+uPointer.x*.2+uScroll*.2);
    vec3 p=r*form;
    float d=7.8-p.z;
    gl_Position=vec4(p.x*2.25/uAspect,p.y*2.25,-p.z*.15,d);
    gl_PointSize=uPoint*(8./d);
    vNormal=r*aNormal;vWorld=p;vPath=aPath;vDepth=clamp((p.z+3.)/6.,0.,1.);
  }`;
  const fragment = `
  precision mediump float;
  uniform float uTime; uniform float uMode; uniform float uOpacity;
  varying vec3 vNormal; varying vec3 vWorld; varying float vPath; varying float vDepth;
  void main(){
    vec3 n=normalize(vNormal);vec3 eye=normalize(vec3(0.,0.,8.)-vWorld);
    float diffuse=abs(dot(n,normalize(vec3(-.35,.7,1.))));
    float fresnel=pow(1.-abs(dot(n,eye)),2.);
    float spec=pow(abs(dot(reflect(-normalize(vec3(-.6,.9,1.)),n),eye)),20.);
    vec3 metal=mix(vec3(.012,.055,.075),vec3(.30,.57,.67),diffuse*.75);
    metal+=vec3(.35,.66,.75)*spec+vec3(.06,.3,.38)*fresnel;
    float phase=fract(vPath*.75-uTime*.075);
    float pulse=pow(max(0.,1.-abs(phase-.5)*11.),4.);
    float alpha=uOpacity;
    if(uMode<.5){ metal+=vec3(.1,.3,.34)*pulse;alpha*=.85; }
    else { metal=mix(vec3(.06,.3,.39),vec3(.69,.97,1.),pulse); alpha*=.3+vDepth*.7; }
    if(uMode>1.5){float d=length(gl_PointCoord-.5)*2.; if(d>1.)discard;alpha*=pow(1.-d,1.5);metal=vec3(.42,.85,1.);}
    gl_FragColor=vec4(metal,alpha);
  }`;
  const shaders=[];
  function shader(type,src){const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const loc=Object.fromEntries(['uTime','uScroll','uAspect','uPointer','uMode','uOpacity','uPoint'].map(k=>[k,gl.getUniformLocation(program,k)]));
  const attrs=['aPosition','aNormal','aPath','aRecord','aHelix'].map(k=>gl.getAttribLocation(program,k));
  // Four continuous folded ribbons: connected layers, rather than a particle cloud.
  function point(t,v,layer){
    const twist=t*1.5+layer*.39;
    const radius=1.72+layer*.115+v*.54*Math.cos(twist);
    return [radius*Math.cos(t),radius*Math.sin(t),v*.72*Math.sin(twist)+.34*Math.sin(t*2.+layer*.32)+(layer-1.5)*.19];
  }
  function sample(t,v,l){
    const p=point(t,v,l),a=point(t+.001,v,l),b=point(t,v+.001,l);
    const x=a.map((n,i)=>n-p[i]),y=b.map((n,i)=>n-p[i]);
    const n=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
    const m=Math.hypot(...n)||1;const record=[(t/TAU-.5)*4.6,v*.95,(l-1.5)*.52+.06*Math.sin(t*2.)];
    const angle=t*2.+(l%2)*Math.PI;const helix=[Math.cos(angle)*(1.+v*.13), (t/TAU-.5)*4.3, Math.sin(angle)*(1.+v*.13)+(l>1?.07:0.)];
    return [...p,...n.map(k=>k/m),t/(Math.PI*2)+l*.19+v*.03,...record,...helix];
  }
  const surface=[],lines=[],nodes=[];const N=240,W=12,TAU=Math.PI*2;
  for(let l=0;l<4;l++){
    for(let i=0;i<N;i++){
      const t=i/N*TAU,tn=(i+1)/N*TAU;
      for(let j=0;j<W;j++){
        const v=j/W*2-1,vn=(j+1)/W*2-1;
        const a=sample(t,v,l),b=sample(tn,v,l),c=sample(t,vn,l),d=sample(tn,vn,l);
        surface.push(...a,...b,...c,...b,...d,...c);
        // Engraved longitudinal paths and measured cross-sections.
        lines.push(...a,...b);
        if(i%8===0)lines.push(...a,...c);
        if(i%24===0&&j%3===0)nodes.push(...a);
      }
      lines.push(...sample(t,1,l),...sample(tn,1,l));
    }
  }
  // Long, precise trajectories feed and continue beyond the structure.
  for(let l=0;l<9;l++)for(let i=0;i<160;i++){
    const f=(u)=>{const t=u*TAU*.79-.15;const r=2.65+l*.024;const p=[r*Math.cos(t),r*.85*Math.sin(t),-.65+Math.sin(t)*.2];return [...p,0,0,1,u+l*.05,...p,...p];};
    lines.push(...f(i/160),...f((i+1)/160));
  }
  const buffers=[];
  function upload(data){const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);return {b,count:data.length/13};}
  const mesh=upload(surface),wire=upload(lines),dots=upload(nodes);
  function draw(buffer,mode,opacity,primitive,size=1){
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer.b);
    attrs.forEach((a,i)=>{gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,i===2?1:3,gl.FLOAT,false,52,[0,12,24,28,40][i]);});
    gl.uniform1f(loc.uMode,mode);gl.uniform1f(loc.uOpacity,opacity);gl.uniform1f(loc.uPoint,size);gl.drawArrays(primitive,0,buffer.count);
  }
  let width=1,height=1,paused=false,visible=true,dead=false,raf=0,last=0,time=0,scroll=0;
  let pointer=[0,0],target=[0,0];
  function resize(){
    const rect=canvas.getBoundingClientRect();const dpr=Math.min(window.devicePixelRatio||1,1.75);
    width=Math.max(1,Math.round(rect.width*dpr));height=Math.max(1,Math.round(rect.height*dpr));
    canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);render();
  }
  function render(){
    if(dead||gl.isContextLost())return;
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(loc.uTime,time);gl.uniform1f(loc.uScroll,scroll);gl.uniform1f(loc.uAspect,width/height);gl.uniform2f(loc.uPointer,...pointer);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.enable(gl.DEPTH_TEST);gl.depthMask(true);
    draw(mesh,0,.95,gl.TRIANGLES);
    gl.depthMask(false);gl.depthFunc(gl.LEQUAL);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
    draw(wire,1,.5,gl.LINES);draw(dots,2,.75,gl.POINTS,5*Math.min(window.devicePixelRatio||1,1.75));
    gl.depthMask(true);
  }
  function frame(now){raf=0;if(dead||paused||!visible||document.hidden)return;time+=last?Math.min((now-last)/1000,.05):0;last=now;pointer=pointer.map((v,i)=>v+(target[i]-v)*.045);render();raf=requestAnimationFrame(frame);}
  function sync(){if(raf)cancelAnimationFrame(raf);raf=0;last=0;if(!dead&&!paused&&visible&&!document.hidden)raf=requestAnimationFrame(frame);}
  function move(e){const r=canvas.getBoundingClientRect();target=[(e.clientX-r.left)/r.width-.5,(e.clientY-r.top)/r.height-.5];}
  function leave(){target=[0,0];}
  canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerleave',leave);document.addEventListener('visibilitychange',sync);
  const ro=new ResizeObserver(resize);ro.observe(canvas);
  const io=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();});io.observe(canvas);
  function lost(event){event.preventDefault();if(raf)cancelAnimationFrame(raf);raf=0;canvas.dataset.renderState='context-lost';}
  canvas.addEventListener('webglcontextlost',lost);
  resize();sync();canvas.dataset.renderState='ready';
  return {
    setPaused(value){paused=Boolean(value);sync();},
    setScroll(value){scroll=Math.max(0,Math.min(5,value));if(paused)render();},
    destroy(){dead=true;if(raf)cancelAnimationFrame(raf);ro.disconnect();io.disconnect();canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerleave',leave);canvas.removeEventListener('webglcontextlost',lost);document.removeEventListener('visibilitychange',sync);buffers.forEach(b=>gl.deleteBuffer(b));shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program);}
  };
}
