import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("AILedger proxy worker", () => {
	describe("GET /health", () => {
		it("returns 200 with status:ok (unit style)", async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>(
				"http://example.com/health"
			);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: "ok" });
		});

		it("returns 200 with status:ok (integration style)", async () => {
			const response = await SELF.fetch("http://example.com/health");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status: "ok" });
		});
	});

	describe("unknown routes", () => {
		it("returns 404 for unmatched paths", async () => {
			const response = await SELF.fetch("http://example.com/does-not-exist");
			expect(response.status).toBe(404);
		});
	});

	describe("/proxy/<provider> auth", () => {
		it("rejects missing x-ailedger-key with 401", async () => {
			const response = await SELF.fetch(
				"http://example.com/proxy/openai/chat/completions",
				{ method: "POST" }
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				error: "Missing x-ailedger-key header",
			});
		});

		it("rejects unknown provider with 400", async () => {
			const response = await SELF.fetch(
				"http://example.com/proxy/bogus/anything",
				{
					method: "POST",
					headers: { "x-ailedger-key": "agl_sk_fake" },
				}
			);
			expect(response.status).toBe(400);
		});
	});
});
