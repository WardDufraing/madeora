import { createSupabaseServerClient } from "@/auth/supabase-server";
import { deviceSecretHash, newDeviceSecret, setDeviceCookie } from "@/child-sign-in/device";
import { approveDeviceSchema } from "@/child-sign-in/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 512;

interface DevicesRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Approves the browser making this request for child PIN sign-in in this Home (S42; spec "On
 * explicitly approved household devices"): the Owner, or an Administrator with
 * manageHomeSettings. The secret goes only into this browser's httpOnly cookie; the database
 * keeps its SHA-256.
 */
export async function POST(request: Request, { params }: DevicesRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, approveDeviceSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const allowed = await requireHomeAction((await params).homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const secret = newDeviceSecret();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("approve_household_device", {
    p_home_id: allowed.context.home.id,
    p_label: input.data.label,
    p_secret_hash: deviceSecretHash(secret),
  });
  if (error) return databaseFailure("household_devices.approve_failed", error.code);
  const row = data[0];
  if (row?.outcome !== "approved" || !row.device_id) return outcomeFailure(row?.outcome ?? "");
  await setDeviceCookie(secret);
  return json(201, { device: { id: row.device_id } });
}
