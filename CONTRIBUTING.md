# Contributing

Kip is a personal project at v0.1, maintained by one person. Feedback is the
main thing I'm looking for right now.

## Feedback, bugs, ideas

- **Bugs** → [Issues](https://github.com/JWE24-code/kip-app/issues) — include
  your OS, the Kip version (Settings → About), and what you did.
- **Ideas / questions / "does anyone else…"** →
  [Discussions](https://github.com/JWE24-code/kip-app/discussions).
- **Security** → see [`SECURITY.md`](SECURITY.md). Don't open a public issue.

## Code

Pull requests are welcome but not guaranteed a merge — this is early and the
architecture is still moving. **Open an issue first** to check the direction
before writing anything non-trivial.

If you do send a PR:

- Retrieval layer (`scripts/`, this repo): `npm install && npm test` must pass.
  Match the surrounding style; keep telemetry content-free.
- App ([kip-app](https://github.com/JWE24-code/kip-app)): `clojure -M:cljs
  compile app electron` must be warning-free. See
  [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
- One focused change per PR. Describe what and why.

## License

By contributing you agree your contribution is licensed under
**AGPL-3.0**, the same as the rest of Kip.
