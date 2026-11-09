# Auto-WeLearn third-party component

Source: https://github.com/SubmergeDQ/Auto-WeLearn
Pinned revision: 9459bb7fafcd98868f9796d6187afd1d5fe6c049
License: GNU GPL version 3, reproduced in LICENSE.

These modules are reused directly, not independently reimplemented. Original TypeScript is retained under source/core. Runtime core/*.mjs is generated solely by stripping types and rewriting local import extensions. Reproduction: node tools/dev/vendor-welearn.mjs <checkout>.

The Kezhan adapter provides its own browser-session transport, task selection, cancellation and platform completion verification. It does not use upstream CLI completion acknowledgements as proof of platform completion.
