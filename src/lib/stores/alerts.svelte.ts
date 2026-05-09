/*
  Tiny global state for the unread-alerts badge. The AlertsListener
  component (mounted in the root layout) is the single writer; any
  component (e.g. the Menu bell) can read .count for reactive display.
*/
function createUnreadAlerts() {
  let count = $state(0);

  return {
    get count() {
      return count;
    },
    set(value: number) {
      count = Math.max(0, value);
    },
    increment() {
      count += 1;
    },
    decrement() {
      count = Math.max(0, count - 1);
    },
  };
}

export const unreadAlerts = createUnreadAlerts();
