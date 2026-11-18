/**
 * The generated database types read every SQL function parameter as required and non-null, while
 * some functions take SQL null as a meaningful value (an occurrence without a time, every pet, the
 * Personal space). This marks such an argument in one reviewed place, instead of an unchecked
 * `as string` at each call (S31c-L8). The value is passed unchanged; supabase-js sends null as
 * JSON null.
 */
export function nullableArg(value: string | null): string {
  // The single deliberate widening: the database function accepts null for this parameter.
  return value as string;
}
