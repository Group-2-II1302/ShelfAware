export async function getShelf(shelfId: string) {
  const res = await fetch(`/api/shelves/${shelfId}`);
  if (!res.ok) throw new Error("Shelf fetch failed");
  return res.json();
}