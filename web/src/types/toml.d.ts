declare module "smol-toml" {
  export function parse(input: string): Record<string, unknown>;
  export function stringify(input: Record<string, unknown>): string;
}
