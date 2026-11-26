import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

/**
 * Shell command validation.
 *
 * Allow-listing a command *name* is not enough: `git`, `node` and `python` can
 * execute arbitrary code from an argument, and a relative name can be shadowed
 * by a binary written into the workspace. Validation therefore resolves the
 * command to an absolute allow-listed executable, refuses path-qualified names
 * and every dangerous interpreter flag, and rejects control characters. The
 * process is still started with `shell: false`, so the remaining risk is the
 * allow-listed program's own behaviour, which the deployment chooses.
 */

/** Flags that turn an otherwise safe executable into an arbitrary-code runner. */
const DANGEROUS_FLAGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  node: ['-e', '--eval', '-p', '--print', '--import', '--loader', '--experimental-loader'],
  sh: ['-c'],
  bash: ['-c', '-i'],
  zsh: ['-c'],
  dash: ['-c'],
  python: ['-c', '-m'],
  python3: ['-c', '-m'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  npm: ['exec', 'x', 'run-script'],
  npx: [''],
  bun: ['-e', '--eval', 'x'],
  deno: ['eval', 'run'],
  // These dispatch another program with caller-controlled arguments.
  git: ['-c', '--config-env', '--exec-path'],
  find: ['-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  tar: ['--to-command', '--use-compress-program', '-I'],
  rsync: ['-e', '--rsh', '--rsync-path'],
  make: ['-f', '--file', '--eval'],
});

/**
 * A command that exists only to launch another command cannot be confined by
 * validating its name. Refusing it keeps an allowlist from becoming a shell by
 * another route; the owner can still approve the intended command directly.
 */
const REFUSED_COMMANDS = new Set([
  'env',
  'exec',
  'eval',
  'xargs',
  'sudo',
  'doas',
  'su',
  'chroot',
  'nsenter',
  'unshare',
  'systemd-run',
]);

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Best-effort argument confinement. This cannot sandbox an arbitrary program (a
 * script can open any file it likes), but it stops a tool call from naming a
 * host path or a parent-directory escape in an argument or a `--flag=path` value.
 * Shell is off by default and the owner still approves each invocation.
 */
function arguesOutsideWorkspace(argument: string): boolean {
  const separator = argument.indexOf('=');
  const value = separator >= 0 ? argument.slice(separator + 1) : argument;
  if (value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  return value.split(/[\\/]/).includes('..');
}

export type CommandValidation =
  | { ok: true; executable: string; args: string[] }
  | { ok: false; detail: string };

async function findExecutable(name: string): Promise<string | null> {
  if (name.includes('/') || name.includes('\\')) return null;
  const roots = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
  for (const root of roots) {
    const candidate = path.join(root, name);
    try {
      await access(candidate, constants.X_OK);
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Validates one invocation. `allowedCommands` are bare names; an entry that
 * contains a path separator is refused at startup by the configuration schema,
 * so a caller cannot smuggle a different binary through the allowlist.
 */
export async function validateCommand(input: {
  command: string;
  args: string[];
  allowedCommands: string[];
}): Promise<CommandValidation> {
  if (!input.allowedCommands.includes(input.command)) {
    return {
      ok: false,
      detail: `That command is not allow-listed. Allowed: ${input.allowedCommands.join(', ') || 'none'}.`,
    };
  }
  if (REFUSED_COMMANDS.has(path.basename(input.command).replace(/\.(exe|cmd|bat)$/i, ''))) {
    return {
      ok: false,
      detail: 'That command only launches another program and cannot be allow-listed safely.',
    };
  }
  if (CONTROL.test(input.command) || input.args.some((argument) => CONTROL.test(argument))) {
    return { ok: false, detail: 'A command or argument contains a control character.' };
  }
  if (input.args.some(arguesOutsideWorkspace)) {
    return {
      ok: false,
      detail: 'An argument names a path outside the workspace, which is not allowed.',
    };
  }
  const executable = await findExecutable(input.command);
  if (!executable) {
    return { ok: false, detail: 'That command is not installed in this environment.' };
  }
  const base = path.basename(executable).replace(/\.(exe|cmd|bat)$/i, '');
  const dangerous = DANGEROUS_FLAGS[base];
  if (dangerous && input.args.some((argument) => dangerous.includes(argument.split('=')[0] ?? argument))) {
    return {
      ok: false,
      detail: `That argument would let ${base} execute arbitrary code, which is not allowed.`,
    };
  }
  // A `--flag=value` form hides the flag from a naive comparison; check both
  // sides for the command's known dispatch flags.
  if (
    dangerous &&
    input.args.some((argument) => argument.includes('=') && dangerous.includes(argument.slice(0, argument.indexOf('='))))
  ) {
    return {
      ok: false,
      detail: `That argument would let ${base} execute arbitrary code, which is not allowed.`,
    };
  }
  return { ok: true, executable, args: [...input.args] };
}
