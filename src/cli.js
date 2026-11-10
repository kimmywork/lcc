#!/usr/bin/env node
/**
 * LCC command-line tool.
 *
 *   lcc encode --input "Hello" --output hello.png --layer L2
 *   lcc encode --input-file examples/心经.txt --output sutra.png --layer L3b --size 2048
 *   lcc decode --input sutra.png
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodeAuto } from './decoder.js';
import { encode } from './encoder.js';
import { ECC_LEVELS, ECC_NAMES, LAYERS } from './constants.js';
import { decodePNG, encodePNG } from './png.js';
import { renderSVG } from './svg.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) {
        args[key.slice(3)] = false;
      } else if (key === 'help') {
        args.help = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`LCC — Layered Chromatic Code

Usage:
  lcc encode [options]
    --input <text>         text payload
    --input-file <path>    read payload from file (UTF-8)
    --output <path>        output PNG (required)
    --layer <name>          L1/L2a/L3b/L3c/L1s/L2s/L3s/L3t/... default L1
    --size <px>            canvas side, default 1024
    --mode <fill|compact>  default fill
    --palette <maxmin|harmony>  default maxmin
    --ecc <auto|L|M|Q|H>   error correction level, default auto
    --boost-ecc            use the highest ECC that fits (same version)
    --no-boost-ecc         disable boost (default)
    --min-version <1..100> minimum version, default 1
    --max-version <1..100> maximum version, default 100
    --module-size <px>     fixed module size
    --quiet-zone <n>       quiet zone in modules
    --format <png|svg>     output format (default from extension)
    --constraint           enable reversible constraint (default on for L2/L3)
    --no-constraint        disable constraint (recommended for camera)
    --seed <0..63>         whitening seed, default 0

  lcc decode --input <path> [--output <path>] [--json]
  lcc info
`);
}

function cmdEncode(args) {
  if (!args.output) throw new Error('encode: --output is required');
  let payload;
  if (args['input-file']) payload = fs.readFileSync(args['input-file'], 'utf8');
  else if (args.input !== undefined) payload = String(args.input);
  else throw new Error('encode: provide --input or --input-file');
  const layer = args.layer ?? 'L1';
  if (!LAYERS[layer]) throw new Error(`unknown layer: ${layer}`);
  const size = Number(args.size ?? 1024);
  const constraint = args.constraint === false ? false : args.constraint === true ? true : undefined;
  const format = args.format ?? (String(args.output).toLowerCase().endsWith('.svg') ? 'svg' : 'png');
  const result = encode(payload, {
    layer,
    width: size,
    height: size,
    mode: args.mode ?? 'fill',
    paletteMode: args.palette ?? 'maxmin',
    constraint,
    seed: Number(args.seed ?? 0),
    maxModulePx: 32,
    eccLevel: args.ecc ?? 'auto',
    boostEcc: args['boost-ecc'] === true,
    minVersion: args['min-version'] ? Number(args['min-version']) : undefined,
    maxVersion: args['max-version'] ? Number(args['max-version']) : undefined,
    moduleSize: args['module-size'] ? Number(args['module-size']) : undefined,
    quietZone: args['quiet-zone'] ? Number(args['quiet-zone']) : undefined,
  });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  if (format === 'svg') {
    const svg = renderSVG({
      symbols: result.symbols,
      layout: result.layout,
      palette: result.paletteInfo.palette,
      moduleSize: result.meta.moduleSize,
      quietZone: result.meta.quietZone,
    });
    fs.writeFileSync(args.output, svg);
  } else {
    fs.writeFileSync(args.output, encodePNG(result.image));
  }
  console.log(JSON.stringify({ output: args.output, format, ...result.meta }, null, 2));
}

function cmdDecode(args) {
  if (!args.input) throw new Error('decode: --input is required');
  const image = decodePNG(fs.readFileSync(args.input));
  const result = decodeAuto(image);
  if (args.output) {
    fs.writeFileSync(args.output, result.payload);
    console.log(`decoded ${result.payload.length} bytes -> ${args.output}`);
  } else if (args.json) {
    console.log(JSON.stringify({
      text: result.text,
      bytes: result.payload.length,
      meta: result.meta,
    }, null, 2));
  } else {
    if (result.text !== null) console.log(result.text);
    else console.log(`[binary ${result.payload.length} bytes] ${Buffer.from(result.payload).toString('hex')}`);
    console.error(JSON.stringify(result.meta));
  }
}

function cmdInfo() {
  for (const layer of Object.values(LAYERS)) {
    const eccName = ECC_NAMES[ECC_LEVELS.indexOf(layer.ecc)] ?? '?';
    const shapeCount = layer.shapeSetSize ?? 1;
    const symbols = shapeCount * layer.paletteSize;
    const shapeInfo = shapeCount > 1
      ? ` (${layer.paletteSize} colors × ${shapeCount} shapes)`
      : '';
    console.log(`${layer.name}: ${symbols} symbols${shapeInfo}, ${layer.bitsPerModule} bit/module, ECC ${eccName} (${(layer.ecc * 100).toFixed(0)}%), ${layer.description}`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const command = args._[0];
  if (command === 'encode') cmdEncode(args);
  else if (command === 'decode') cmdDecode(args);
  else if (command === 'info') cmdInfo();
  else {
    usage();
    process.exit(1);
  }
} catch (error) {
  console.error(`lcc: ${error.message}`);
  process.exit(1);
}
