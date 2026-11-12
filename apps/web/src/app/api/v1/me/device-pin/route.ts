import { createSupabaseServerClient } from "@/auth/supabase-server";
import { myDevicePinSchema } from "@/child-sign-in/schema";
import { hashChildSecret } from "@/child-sign-in/secret-hash";
import { databaseFailure, failure, json, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 128;

/**
 * An adult sets or removes their own household-device PIN (S42 part 2), which confirms chores
 * they record on an approved household device. The PIN is hashed here and never logged, stored or
 * echoed in clear. Children's PINs are their guardians' to set: the database refuses a child.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMemberMutation(request, myDevicePinSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  const { pin } = input.data;
  const { data, error } = await supabase.rpc(
    "set_my_device_pin",
    pin === null ? {} : { p_hash: await hashChildSecret(pin) },
  );
  if (error?.code === "42501") return failure(403, "not-permitted");
  if (error) return databaseFailure("my_device_pin.failed", error.code);
  return json(200, { outcome: data });
}
