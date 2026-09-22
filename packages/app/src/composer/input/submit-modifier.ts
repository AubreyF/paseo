export type SubmitModifier = "none" | "alternate" | "newline";

const reset = () => {};
export function useSubmitModifier(_enabled: boolean) {
  return { modifier: "none" as SubmitModifier, reset };
}
