export const PI_BASE = "http://192.168.x.x"; // or change to mDNS

export async function checkHealth() {
  const res = await fetch(`${PI_BASE}/health`);
  if (!res.ok) throw new Error("Pi not reachable");
  return res.json();
}

export async function provisionPi(payload: {
  ssid: string;
  password: string;
  user_id: string;
}) {
  const res = await fetch(`${PI_BASE}/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (res.status === 409) throw new Error("Already provisioned");
  if (!res.ok) throw new Error("Provision failed");

  return res.json(); // { status, shelf_id }
}