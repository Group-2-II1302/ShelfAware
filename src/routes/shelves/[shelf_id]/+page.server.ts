import { error, redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals, params }) => {
  const shelfId = params.shelf_id
  const { data: { user } } = await locals.supabase.auth.getUser()

  if (!user) {
    throw redirect(303, '/login')
  }

  /*
    Verify user belongs to this shelf
  */
  const { data: membership, error: membershipError } =
    await locals.supabase
      .from('shelf_members')
      .select('id')
      .eq('user_id', user.id)
      .eq('shelf_id', shelfId)
      .maybeSingle()

  if (membershipError) {
    throw error(500, membershipError.message)
  }

  if (!membership) {
    throw error(403, 'Shelf access denied')
  }

  /*
    Load shelf metadata
  */
  const { data: shelf, error: shelfError } =
    await locals.supabase
      .from('shelves')
      .select('id, name')
      .eq('id', shelfId)
      .single()

  if (shelfError) {
    throw error(500, shelfError.message)
  }

  /*
    Load shelf items + product names
    shelf_items.barcode → product_catalog.barcode
  */
  const { data: items, error: itemsError } =
    await locals.supabase
      .from('shelf_items')
      .select(`
        id,
        barcode,
        expiry_date,
        product_catalog (
          product_name
        )
      `)
      .eq('shelf_id', shelfId)
      .order('created_at', { ascending: true })

  if (itemsError) {
    throw error(500, itemsError.message)
  }

  return {
    shelf,
    items: items ?? []
  }
}