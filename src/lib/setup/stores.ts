import { writable } from "svelte/store";

export type SetupStep = "idle" | "waiting" | "success" | "error";

export type SetupState = {
  step: SetupStep;
  shelfId: string | undefined;
  error: string | undefined;
};

export const setupState = writable<SetupState>({
  step: "idle",
  shelfId: undefined as string | undefined,
  error: undefined as string | undefined,
});
