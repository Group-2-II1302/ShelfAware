import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ locals }) => {
  const { data: shelves, error } = await locals.supabase
    .from('shelves')
    .select('id, name')
    .order('name')

  if (error) {
    throw error
  }

  return {
    shelves,
  }
}