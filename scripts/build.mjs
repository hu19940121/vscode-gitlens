#!/usr/bin/env node
import { spawn } from 'child_process';
import { parseArgs } from 'node:util';

// Parse arguments
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		analyzeBundle: { type: 'boolean', default: false },
		mode: { type: 'string', default: 'development' }, // development | production | none
		build: { type: 'string', default: undefined, multiple: true }, // (extension | webviews)[]
		debug: { type: 'boolean', default: false },
		'low-memory': { type: 'boolean', default: process.env.GL_LOW_MEMORY === '1' },
		target: { type: 'string', default: undefined, multiple: true }, // (node | webworker)[]
		quick: { type: 'boolean', default: false }, // skip type-checking, linting, docs, and asset generation
		stats: { type: 'boolean', default: false }, // emit out/webviews-stats.json from the real production build
		trace: { type: 'boolean', default: false },
		webview: { type: 'string', default: undefined, multiple: true },
		watch: { type: 'boolean', default: false },
	},
});

/** @type {{ analyzeBundle: boolean; mode: 'production' | 'development' | 'none' | undefined; build: ('extension' | 'webviews' | 'unit-tests')[] | undefined; debug: boolean; 'low-memory': boolean; target: ('node' | 'webworker')[] | undefined; quick: boolean; stats: boolean; trace: boolean; webview: string[] | undefined; watch: boolean }} */
const {
	analyzeBundle,
	mode,
	build,
	debug,
	'low-memory': lowMemory,
	target,
	quick,
	stats,
	trace,
	webview: webviews,
	watch,
} = values;

if (lowMemory && watch) {
	console.error('Low-memory mode requires a one-shot build; watch processes cannot run sequentially.');
	process.exit(1);
}

const env = {
	...process.env,
	...(debug ? { DEBUG: '1' } : {}),
	...(lowMemory ? { GL_LOW_MEMORY: '1', GOMAXPROCS: '1', RAYON_NUM_THREADS: '1' } : {}),
	NODE_FORCE_COLORS: '1',
	FORCE_COLOR: '1',
};
delete env.NO_COLOR;

// Build webpack command
let cmd = `webpack`;
if (watch) {
	cmd += ' --watch';
} else {
	cmd += ' --fail-on-warnings';
}
cmd += ` --mode ${mode}`;
if (build?.length || webviews?.length) {
	if (build?.includes('extension')) {
		if (target?.length) {
			target.forEach(t => {
				cmd += ` --config-name extension:${t}`;
			});
		} else {
			cmd += ` --config-name extension:node --config-name extension:webworker`;
		}
	}

	if (build?.includes('webviews') || webviews?.length) {
		cmd += ` --config-name webviews:common`;

		if (webviews?.length === 1) {
			cmd += ` --config-name webviews:${webviews[0]}`;
		} else {
			cmd += ` --config-name webviews`;
		}

		if (webviews?.length) {
			cmd += ` --env webviews=${webviews.join(',')}`;
		}
	}

	if (build?.includes('unit-tests')) {
		cmd += ` --config-name unit-tests`;
	}
} else if (target?.length) {
	target.forEach(t => {
		cmd += ` --config-name extension:${t}`;
	});

	cmd += ` --config-name webviews:common`;

	if (webviews?.length === 1) {
		cmd += ` --config-name webviews:${webviews[0]}`;
	} else {
		cmd += ` --config-name webviews`;
	}

	if (webviews?.length) {
		cmd += ` --env webviews=${webviews.join(',')}`;
	}
}

if (quick) {
	cmd += ` --env quick`;
}

if (lowMemory) {
	cmd += ` --env lowMemory`;
}

if (analyzeBundle) {
	cmd += ` --env analyzeBundle`;
}

if (stats) {
	cmd += ` --env stats`;
}

if (trace) {
	cmd += ` --env trace`;
}

if (build?.includes('unit-tests')) {
	const buildPkgsCmd = `pnpm run build:packages`;
	console.log(`Running: ${buildPkgsCmd}`);

	const pkgsCode = await new Promise(resolve => {
		const pkgs = spawn(buildPkgsCmd, {
			shell: true,
			stdio: 'inherit',
			env: env,
		});

		pkgs.on('exit', (code, signal) => resolve(exitCode(code, signal)));
	});

	if (pkgsCode !== 0) {
		process.exit(pkgsCode);
	}
}

// A "full" build targets no specific config (the default `pnpm run build`) — these are the ones
// we split across processes below.
const isFullBuild = !build?.length && !target?.length && !webviews?.length;

if (!quick && !watch) {
	const fmtCmd = process.env.CI ? `pnpm run fmt:check` : `pnpm run fmt`;
	console.log(`Running: ${fmtCmd}`);

	const formatCode = await new Promise(resolve => {
		const fmt = spawn(fmtCmd, {
			shell: true,
			stdio: 'inherit',
			env: env,
		});

		fmt.on('exit', (code, signal) => resolve(exitCode(code, signal)));
	});

	if (formatCode !== 0) {
		process.exit(formatCode);
	}
}

/**
 * A child killed by a signal exits with a null code — scoring that as 0 would report a build that
 * was OOM-killed or interrupted as a success.
 * @param {number | null} code @param {NodeJS.Signals | null} signal @returns {number}
 */
function exitCode(code, signal) {
	if (code != null) return code;
	return signal != null ? 1 : 0;
}

/** @param {string} command @returns {Promise<number>} exit code (always resolves; never rejects) */
function run(command) {
	console.log(`Running: ${command}`);
	const child = spawn(command, { shell: true, stdio: 'inherit', env: env });
	return new Promise(resolve => {
		child.on('exit', (code, signal) => resolve(exitCode(code, signal)));
		// Spawn failures emit 'error' without 'exit' — resolve as failure so the batch never hangs.
		child.on('error', () => resolve(1));
	});
}

// For one-shot full builds, split the 6-config webpack MultiCompiler (which shares a single Node
// event loop, leaving most cores idle) into parallel webpack processes — one per bucket — so the
// CPU-bound work (module-graph build, codegen, source maps) spreads across cores. Buckets keep
// configs that share in-process state together (webviews:common + webviews). Watch and targeted
// builds keep the single-process path.
let bundleCmds;
if (isFullBuild && !watch) {
	let baseCmd = `webpack --mode ${mode} --fail-on-warnings`;
	if (quick) {
		baseCmd += ` --env quick`;
	}
	if (trace) {
		baseCmd += ` --env trace`;
	}
	if (lowMemory) {
		baseCmd += ` --env lowMemory`;
	}

	bundleCmds = [
		// `common` is pure codegen (empty entry; Docs/Licenses/Fantasticon/contributions all run as
		// blocking spawnSync) — isolate it so that blocking work gets its own core instead of stalling
		// a bundling process's event loop.
		`${baseCmd} --config-name common`,
		`${baseCmd} --config-name extension:node`,
		`${baseCmd} --config-name extension:webworker`,
		`${baseCmd}${analyzeBundle ? ' --env analyzeBundle' : ''}${stats ? ' --env stats' : ''} --config-name webviews:common --config-name webviews`,
		`${baseCmd} --config-name unit-tests`,
	];
} else {
	bundleCmds = [cmd];
}

// Run the bundle process(es) and, for one-shot builds, a single whole-project oxlint (lint +
// type-check) pass concurrently. tsgo-backed type checking and Rust-native linting both run inside
// oxlint, so a single pass covers both. Watch builds lint incrementally via
// the inline OxLintWebpackPlugin (added whenever not in quick mode), so they skip this standalone pass.
const commands = [...bundleCmds];
if (!quick && !watch) {
	commands.push('oxlint --type-aware --type-check --deny-warnings');
	commands.push(`node ./scripts/check-deps.mjs`);
	commands.push(`node ./scripts/check-color-tokens.mjs`);
	commands.push(`node ./scripts/localization.mjs check`);
}

if (lowMemory) {
	// Give each webpack config its own process, releasing its module graph before the next config.
	// In particular, webviews:common must finish copying shared assets before webviews consumes them.
	const sequentialCommands = commands.flatMap(command => {
		const names = [...command.matchAll(/ --config-name (\S+)/g)];
		if (names.length < 2) return [command];

		const baseCommand = command.replace(/ --config-name \S+/g, '');
		return names.map(([, name]) => `${baseCommand} --config-name ${name}`);
	});

	console.log('[build] Low-memory mode: running build targets and checks sequentially');
	for (const command of sequentialCommands) {
		const code = await run(command);
		if (code !== 0) {
			console.error('[build] Compiled with problems');
			process.exit(code);
		}
	}

	console.log('[build] Compiled successfully');
	process.exit(0);
}

const tasks = commands.map(c => run(c));

// allSettled (not all) so a failure in one process never abandons the others mid-flight — every
// bundle process runs to completion, then we fail the build with the first non-zero exit code.
const results = await Promise.allSettled(tasks);
const codes = results.map(result => (result.status === 'fulfilled' ? result.value : 1));
const failed = codes.find(code => code !== 0) ?? 0;

// With multiple bundle processes, each prints its own per-process status; emit one aggregate line.
if (bundleCmds.length > 1) {
	console.log(failed ? '[build] Compiled with problems' : '[build] Compiled successfully');
}

process.exit(failed);
