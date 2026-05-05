export type SetupErrorAction =
  | { type: "RESET_SETUP" }
  | { type: "RETRY_WIFI_CHECK" }
  | { type: "RETRY_PROVISION" }
  | { type: "RETRY_CONNECTING" };