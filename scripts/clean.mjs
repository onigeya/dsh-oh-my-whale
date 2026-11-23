#!/usr/bin/env node
/**
 * Remove the build output so a deleted source file cannot leave a stale artifact
 * behind (a removed `src/cli.ts` kept shipping `lib/cli.js`).
 * @module
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const lib = fileURLToPath(new URL('../lib/', import.meta.url))
rmSync(lib, { recursive: true, force: true })
