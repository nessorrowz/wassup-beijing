# Licences

Every dependency is recorded here as it is added (NFR-11). No copyleft (GPL or AGPL) code
is copied into this repository, and no dependency is modified.

Generated from the installed tree with `npm ls --all` and the `license` field of each
`package.json`. Regenerate the summary with:

```bash
npm ls --all --json > /dev/null   # or inspect node_modules/*/package.json
```

## Direct dependencies

| Package             | Version | Licence    | Why it is here                             |
| ------------------- | ------- | ---------- | ------------------------------------------ |
| `@hono/node-server` | 2.1.4   | MIT        | Local dev server for the relay function    |
| `dexie`             | 4.4.6   | Apache-2.0 | IndexedDB wrapper for browser-only storage |
| `hono`              | 4.13.13 | MIT        | The one serverless relay function          |
| `pdfjs-dist`        | 6.4.299 | Apache-2.0 | Reads the text layer of policy PDFs        |
| `react`             | 19.3.0  | MIT        | UI                                         |
| `react-dom`         | 19.3.0  | MIT        | UI                                         |
| `zod`               | 4.6.7   | MIT        | Schemas and validation for every entity    |

## Direct dev dependencies

| Package                       | Version | Licence    | Why it is here                       |
| ----------------------------- | ------- | ---------- | ------------------------------------ |
| `@eslint/js`                  | 9.39.5  | MIT        | ESLint recommended rules             |
| `@playwright/test`            | 1.64.0  | Apache-2.0 | End-to-end smoke test                |
| `@testing-library/jest-dom`   | 7.0.1   | MIT        | DOM matchers                         |
| `@testing-library/react`      | 16.3.3  | MIT        | Rendering React in tests             |
| `@testing-library/user-event` | 14.6.8  | MIT        | Simulating user input in tests       |
| `@types/node`                 | 26.6.5  | MIT        | Node types for scripts and the relay |
| `@types/react`                | 19.3.0  | MIT        | React types                          |
| `@types/react-dom`            | 19.3.0  | MIT        | React DOM types                      |
| `@vitejs/plugin-react`        | 6.1.2   | MIT        | React fast refresh in Vite           |
| `eslint`                      | 9.39.5  | MIT        | Linting                              |
| `eslint-config-prettier`      | 10.1.8  | MIT        | Keeps ESLint out of formatting       |
| `eslint-plugin-react-hooks`   | 7.1.1   | MIT        | Hook rules                           |
| `eslint-plugin-react-refresh` | 0.5.7   | MIT        | Fast refresh rules                   |
| `fake-indexeddb`              | 6.2.5   | Apache-2.0 | IndexedDB in Node for unit tests     |
| `globals`                     | 16.5.0  | MIT        | Browser and Node globals for ESLint  |
| `jsdom`                       | 30.1.2  | MIT        | DOM environment for the UI tests     |
| `prettier`                    | 3.9.10  | MIT        | Formatting                           |
| `typescript`                  | 5.9.3   | Apache-2.0 | The language                         |
| `typescript-eslint`           | 8.71.2  | MIT        | TypeScript rules for ESLint          |
| `vite`                        | 8.3.4   | MIT        | Dev server and production build      |
| `vitest`                      | 5.0.4   | MIT        | Unit tests                           |

## Transitive dependency licences

258 packages are installed in total (direct plus transitive) on macOS arm64; the count
differs slightly by platform because native binaries are per-platform. Licence counts:

| Licence       | Packages |
| ------------- | -------- |
| MIT           | 199      |
| Apache-2.0    | 25       |
| ISC           | 12       |
| BSD-2-Clause  | 8        |
| BlueOak-1.0.0 | 4        |
| BSD-3-Clause  | 3        |
| MIT-0         | 2        |
| MPL-2.0       | 2        |
| CC0-1.0       | 1        |
| CC-BY-4.0     | 1        |
| Python-2.0    | 1        |

Notes on the entries that are not MIT, Apache, ISC or BSD:

- `lightningcss` and its per-platform binary (MPL-2.0) are pulled in by Vite as a
  **build-time** CSS transformer. They are used unmodified, are not copied into this
  repository, and are not distributed as part of the built site. MPL-2.0 is file-level
  copyleft, so an unmodified dependency does not affect our licence.
- `lru-cache` and `minimatch` (BlueOak-1.0.0, a permissive licence) are transitive
  dependencies of jsdom and typescript-eslint: test and lint tooling only.
- `caniuse-lite` (CC-BY-4.0) and `argparse` (Python-2.0) are transitive build-time data
  and utility packages, also unmodified and not redistributed.
- `@napi-rs/canvas` (MIT) is an optional dependency of `pdfjs-dist` for rendering pages in
  Node. This project only reads text, never renders, and it is not part of the built site.
- There is **no GPL or AGPL code anywhere in the dependency tree.**

`pdfjs-dist` is the only third-party code that ships in the built site besides React,
Dexie and Zod. It is loaded from this origin, on demand, when a policy PDF is opened.

## Platform components (no dependency, no licence to record)

| Component      | Provided by          | Used for                               |
| -------------- | -------------------- | -------------------------------------- |
| Web Crypto     | The browser and Node | SHA-256 hash chain, PBKDF2 PIN hashing |
| IndexedDB      | The browser          | All ledger storage                     |
| Service worker | The browser          | Installable PWA app shell              |

## Hosted model service (no code in the repository)

| Service         | Provided by                                              | Used for                                                       | Terms                                                                                                          |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `glm-5.3-flash` | Hyper (`hyper.charm.land`), an OpenAI-compatible gateway | Chat replies and tool calls in the deployed site (decision D5) | Hyper's terms of service and the model provider's usage policy; called only from the relay with the team's key |

No model weights or provider SDKs are in the tree; the relay speaks plain HTTPS to the
provider. The rule-based model in `src/agent/mock-model.ts` is our own code.

## Our own code

All source in `src/`, `scripts/`, `relay/`, `api/`, `tools/`, `tests/` and `fixtures/` is written by
the team for this submission. That includes the synthetic policy documents in
`fixtures/policies/` and `public/samples/`: the insurers, the insured person and every
figure in them are invented, and no wording is copied from a real policy. It is unlicensed in this repository (all rights reserved by the
team) and contains no copied third-party code.
