# Workstate

## Focus

LCC 扫描：定位色偏矫正，以及网页用的 C/WASM 合成与解码。

## Status

色偏矫正、WASM 合成和 WASM 解码已接上。`npm test` 通过。网页拍照和连续扫描优先走 WASM。

## Recent

- finder/alignment 白点有色偏时按通道归一化，清洁图仍走亮度场。
- `native/` C 核心编成 `docs/lib/lcc.wasm`，由 `docs/lib/lcc-wasm.js` 加载。

## Next

有 `emcc` 时用 `npm run build:wasm` 重编一份 Emscripten 产物。constraint 码目前仍由 JS 解码。

## References

- `.agents/worklog/2026-11-10.md`
- `docs/lcc-spec.md` 8.3、8.5
- `native/`、`docs/lib/lcc.wasm`
