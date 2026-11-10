# Workstate

## Focus

扫描只解码一次，整数网格采样，以及 wasm SIMD。

## Status

`npm test` 21 项通过。干净 L3s 扫描约 30 ms。1600 像素实拍里，能解开的约 216 ms，解不开的约 100–165 ms。难样本仍是笔画被收成空白。

## Recent

- 扫描复用已有单应性，不再把每种二值化都解码一遍。
- 形状采样改为按模块行的整数网格。
- 相关、采样和 2 倍缩小使用 wasm SIMD，wasm 由 emcc 编出。

## Next

难样本的笔画错误仍然超过分块 RS。网页多帧成功时的帧数显示还没有用上 C 扫描的实际合成结果。

## References

- `.agents/worklog/2026-11-11.md`
- `docs/research/wechat-qr-models-and-wasm-speed.md`
- `native/lcc_decode.c` `decode_known`、`warp_module_row`
