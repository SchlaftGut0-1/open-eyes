import type { Target } from "./page.ts";

/** Removes `--name <value>` from args and returns the value. */
export function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

/**
 * Removes the element to act on from args: `--name <text> [--role <role>]`, or else the
 * first argument as a ref. Returns it with a label for the usage log.
 */
export function takeTarget(args: string[], usage: string): [Target, string] {
  const name = takeOption(args, "--name");
  const role = takeOption(args, "--role");
  if (name === undefined) {
    if (role !== undefined) throw new Error("--role needs --name");
    const ref = need(args.shift(), usage);
    return [ref, ref];
  }
  return [{ name, role }, `${role ? `${role} ` : ""}"${name}"`];
}

/** Removes `--name <number>` from args and returns the number, at least `min`. */
export function takeNumber(args: string[], name: string, min: number): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw new Error(`${name} needs a whole number of at least ${min}`);
  return number;
}

/** Removes `--name` from args and returns whether it was there. */
export function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
}

/** Removes `--timeout <seconds>` from args and returns it in milliseconds. */
export function takeTimeout(args: string[]): number | undefined {
  const seconds = takeNumber(args, "--timeout", 1);
  return seconds === undefined ? undefined : seconds * 1000;
}

export function need(arg: string | undefined, usage: string): string {
  if (arg === undefined) throw new Error(`usage: open-eyes ${usage}`);
  return arg;
}
