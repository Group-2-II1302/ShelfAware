import { setupState } from "./stores";
import type { SetupErrorAction } from "./errorActions";
import { get } from "svelte/store";
import { provisionPi, checkHealth } from "../pi";
import { getShelf } from "../api";

export async function handleSetupError(action: SetupErrorAction) {
  const state = get(setupState);

  switch (action.type) {

    case "RESET_SETUP":
      setupState.set({
        step: "wifi",
        deviceId: null,
        shelfId: null,
        error: null,
        loading: false
      });
      break;

    case "RETRY_WIFI_CHECK":
      try {
        const health = await checkHealth();

        setupState.update(s => ({
          ...s,
          deviceId: health.device,
          error: null,
          step: "provision"
        }));
      } catch {
        setupState.update(s => ({
          ...s,
          error: "Device not reachable"
        }));
      }
      break;

    case "RETRY_PROVISION":
      try {
        const res = await provisionPi({
          ssid: state.ssid,
          password: state.password,
          user_id: state.userId
        });

        setupState.update(s => ({
          ...s,
          shelfId: res.shelf_id,
          step: "connecting",
          error: null
        }));
      } catch {
        setupState.update(s => ({
          ...s,
          error: "Provision failed"
        }));
      }
      break;

    case "RETRY_CONNECTING":
      try {
        const shelf = await getShelf(state.shelfId!);

        if (shelf.last_seen) {
          setupState.update(s => ({ ...s, step: "success" }));
        } else {
          setupState.update(s => ({
            ...s,
            error: "Device not ready yet"
          }));
        }
      } catch {
        setupState.update(s => ({
          ...s,
          error: "Connection check failed"
        }));
      }
      break;
  }
}