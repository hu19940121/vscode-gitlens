# Low-memory builds on Linux

Use these entry points on a Linux server with systemd and cgroup v2:

```bash
pnpm run bundle:low-memory   # Compile a complete production bundle
pnpm run package:low-memory  # Compile and create the VSIX
```

Both commands run the entire process tree in a systemd scope with a 768 MiB resident-memory limit
and a separate 3 GiB swap limit. Node's old-space heap limit is explicitly set to 2048 MiB so that
its automatic small heap limit under the cgroup does not prevent it from using swap. This heap
allowance does not override the limits for the process group. If the memory limit cannot be satisfied, the kernel terminates
the scope's processes and the command fails. The wrapper fails if it cannot create the scope;
it never falls back to an unrestricted build. Creating the scope requires permission from systemd
(the current server runs these commands as root).

Build targets and all existing checks run sequentially. Each webpack target exits before the next
starts, so its module graph can be released. JavaScript and CSS minimization use no parallel workers;
image processing, webpack module processing, Go and Rust worker pools are limited to one worker.
The VSIX entry point also passes low-memory mode through the automatic prepublish build.

Verify the resource limits without compiling or packaging anything:

```bash
pnpm run bundle:low-memory --check
```

The server has an additional 4 GiB `/swap-build.img`, enabled immediately and recorded in `/etc/fstab`
for reboot. The existing swap file and `vm.swappiness=60` are retained. The swap file uses 4 GiB of disk.

The ordinary `bundle` and `package` entry points retain their parallel execution. Use the protected
entry points above on this server. Calling `scripts/build.mjs --low-memory` directly selects sequential
execution but does not create the systemd resource limits.

These limits prioritize keeping the server responsive. Compilation may be slow or fail within the
limits; completing the real bundle still requires a separate build run.
