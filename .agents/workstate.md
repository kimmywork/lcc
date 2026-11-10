# Workstate

## Focus

C 扫描路径：模板匹配解码，以及多帧侦测、合成、解码。

## Status

网页拍照和连续扫描优先走 `lcc_api_scan`。干净 L3s 约 26–40 ms。1600 像素实拍里，原本能解的那张约 356 ms。难样本仍过不了 RS。

## Recent

- C 形状分类改为归一化相关，白平衡与 JS 对齐。
- 多帧侦测在 C 内完成，长边超过 960 先缩小。
- `npm test` 21 项通过。

## Next

难样本的笔画错误仍然超过分块 RS。constraint 仍由 JS 解码。

## References

- `.agents/worklog/2026-11-11.md`
- `native/lcc_decode.c` `match_shape`、`lcc_scan_frames`
- `docs/lib/lcc-wasm.js` `scanFramesWasm`
