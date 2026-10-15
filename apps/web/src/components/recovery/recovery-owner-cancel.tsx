"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  cancelRecoveries,
  type CancelRecoveriesResponse,
  type RecoveryActionError,
} from "@/recovery/api";

import { RecoveryFailureAlert } from "./recovery-failure-alert";

/**
 * "I still have access" for the Owner (S12b): ends every open recovery request about the Home.
 * Opening the Home already stopped them; this records the Owner's answer for staff and clears the
 * notice.
 */
export function RecoveryOwnerCancel({ homeId }: { readonly homeId: string }) {
  const t = useTranslations("Recovery");
  const hydrated = useHydrated();
  const [done, setDone] = useState(false);
  const mutation = useMutation<CancelRecoveriesResponse, RecoveryActionError>({
    mutationFn: () => cancelRecoveries(homeId),
    onSuccess: () => {
      setDone(true);
    },
  });

  if (done) {
    return (
      <FormAlert tone="success" announce>
        {t("ownerCancelled")}
      </FormAlert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <RecoveryFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button
          type="button"
          disabled={!hydrated}
          loading={mutation.isPending}
          onClick={() => {
            if (!mutation.isPending) mutation.mutate();
          }}
        >
          {t("ownerCancel")}
        </Button>
      </div>
    </div>
  );
}
