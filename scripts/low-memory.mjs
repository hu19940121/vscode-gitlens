#!/usr/bin/env node
import { spawn } from 'child_process';
import { parseArgs } from 'node:util';
import path from 'path';
import { fileURLToPath } from 'url';

const { values } = parseArgs({
	options: {
		package: { type: 'boolean', default: false },
		check: { type: 'boolean', default: false },
	},
});

if (process.platform !== 'linux') {
	console.error('The protected low-memory entry point requires Linux and systemd.');
	process.exit(1);
}

const rootPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = `gitlens-build-${process.pid}-${Date.now()}`;
const command = values.check
	? [
			process.execPath,
			'--input-type=module',
			'-e',
			`
		import fs from 'node:fs';
		import v8 from 'node:v8';
		const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1];
		const directory = '/sys/fs/cgroup' + group;
		for (const [file, expected] of [['memory.max', '805306368'], ['memory.swap.max', '8589934592'], ['memory.oom.group', '1']]) {
			const actual = fs.readFileSync(directory + '/' + file, 'utf8').trim();
			if (actual !== expected) throw new Error(file + ': expected ' + expected + ', got ' + actual);
			console.log(file + '=' + actual);
		}
		const heapLimit = v8.getHeapStatistics().heap_size_limit;
		if (heapLimit < 2048 * 1024 * 1024) throw new Error('Node heap limit is too low to use the swap allowance.');
		console.log('Node heap limit (MiB)=' + heapLimit / 1024 / 1024);
		console.log('Resource limits verified; no build was started.');
	`,
		]
	: values.package
		? [path.join(rootPath, 'node_modules', '.bin', 'vsce'), 'package', '--no-dependencies']
		: [process.execPath, path.join(rootPath, 'scripts', 'build.mjs'), '--mode', 'production', '--low-memory'];

console.log(`[build] ${unit}.scope: RAM limit 768 MiB, swap limit 8 GiB`);
const child = spawn(
	'systemd-run',
	[
		'--scope',
		'--collect',
		'--no-ask-password',
		'--expand-environment=no',
		`--unit=${unit}`,
		'--property=MemoryMax=768M',
		'--property=MemorySwapMax=8G',
		'--property=OOMPolicy=kill',
		'--',
		...command,
	],
	{
		cwd: rootPath,
		stdio: 'inherit',
		env: {
			...process.env,
			PATH: `${path.join(rootPath, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
			GL_LOW_MEMORY: '1',
			// Node derives a small heap from the cgroup RAM limit; allow its heap to use swap too.
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=2048`.trim(),
			GOMAXPROCS: '1',
			RAYON_NUM_THREADS: '1',
		},
	},
);

child.on('error', error => {
	console.error(`Cannot start the protected build: ${error.message}`);
	process.exitCode = 1;
});
child.on('exit', (code, signal) => {
	if (code !== 0 || signal != null) {
		console.error(
			`Protected command failed (${signal ?? code}). Inspect its output or journalctl -u ${unit}.scope.`,
		);
	}
	process.exitCode = code ?? 1;
});
