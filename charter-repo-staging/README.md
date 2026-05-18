# AILedger Charter

This repository is the canonical source-of-truth for the **AILedger Charter** — the public commitment document that governs how AILedger operates.

The Charter names the customers AILedger refuses, the features AILedger refuses to build, and the decisions that require advisor board review. It is published from day one, before customers, regulators, or the public have asked for it. The credibility of the document depends on its having been written and posted before pressure to compromise it arrived.

## Read it

- **Canonical:** [`CHARTER.md`](./CHARTER.md) in this repository.
- **Versioned:** the `v1.0` git tag in this repository anchors the v1.0 text. Future amendments are tagged sequentially (`v1.1`, `v2.0`, etc.) per the amendment procedure below.
- **Rendered:** [`ailedger.dev/charter`](https://ailedger.dev/charter) renders the canonical text from this repository.

## What this repository is

This is a **publication repository**, not a collaboration repository. The Charter is one document, governed by the procedure described inside it. Issues and discussions are disabled. Anyone can fork the repository, propose amendments via pull request, or simply read and verify the canonical text.

## How amendments work

Per Charter Section *"Decisions requiring board review"*: **any amendment to this charter requires unanimous advisor board approval.**

The mechanics of an amendment:

1. Anyone may open a pull request proposing an amendment (members of the advisor board, AILedger team members, or members of the public).
2. The pull request must include the proposed text change, a rationale, and the date of the change.
3. The pull request is held open until each member of the advisor board has approved it. Unanimous approval is required.
4. Upon unanimous approval, the change is merged and a new version tag (`v1.1` for minor textual revisions, `v2.0` for substantive scope changes) is applied to the resulting commit.
5. The previous version's git tag is preserved, so historical Charter text remains accessible at its versioned URL.

Amendments are public: pull requests, approval signatures, and merge commits are part of the public git history. There is no private amendment path.

## What this repository is not

- It is not a place to file general AILedger product issues. Those belong in the AILedger product repository.
- It is not a place to discuss compliance interpretations of the Charter. Those belong in customer-facing documentation maintained elsewhere.
- It is not a place to propose AILedger feature requests. Charter-refused features are listed in the Charter itself; non-Charter-related features belong in the product repository.

## License

The Charter text is published under [Creative Commons Attribution 4.0 International (CC BY 4.0)](./LICENSE). The text is freely shareable, with attribution to AILedger.

## Contact

For Charter-related questions: `charter@ailedger.dev`.

For product-related questions: see the AILedger product documentation.
