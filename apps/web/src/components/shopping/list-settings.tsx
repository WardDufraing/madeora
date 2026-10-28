"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { sendShoppingRequest, shoppingListEndpoint, type ShoppingListDetail } from "@/shopping/api";
import { shoppingPath } from "@/shopping/format";
import { listNameSchema } from "@/shopping/schema";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

const settingsForm = z.strictObject({
  name: listNameSchema,
  memberAccess: z.enum(["edit", "check", "view"]),
});
type SettingsInput = z.input<typeof settingsForm>;
type SettingsOutput = z.output<typeof settingsForm>;

type Panel = "settings" | "archive" | "delete";

/**
 * A list's settings for its managers (S26): rename, what other members may do (Home lists:
 * Edit, Check off only, View only), archive or restore, and delete. Archiving and deleting say
 * what happens first: how many items are left and that dashboard widgets showing it will say it
 * is no longer available. Every change is revision-checked.
 */
export function ListSettings({
  list,
  homeId,
}: {
  readonly list: ShoppingListDetail;
  readonly homeId: string | null;
}) {
  const t = useTranslations("Shopping");
  const router = useRouter();
  const failure = useShoppingFailure();
  const message = useFieldMessage();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("settings");
  const form = useForm<SettingsInput, unknown, SettingsOutput>({
    resolver: zodResolver(settingsForm),
    defaultValues: { name: list.name, memberAccess: list.memberAccess },
  });
  const activeCount = list.items.filter((item) => item.completedAt === null).length;

  const update = useShoppingMutation(
    `shopping-list:${list.id}`,
    (body: { name: string; memberAccess: string; archived: boolean }) =>
      sendShoppingRequest<object>("PATCH", shoppingListEndpoint(list.id), {
        revision: list.revision,
        ...body,
      }),
    () => {
      setOpen(false);
    },
  );
  const remove = useShoppingMutation(
    `shopping-list:${list.id}`,
    () =>
      sendShoppingRequest<object>("DELETE", shoppingListEndpoint(list.id), {
        revision: list.revision,
      }),
    () => {
      setOpen(false);
      router.push(`${shoppingPath(homeId)}?deleted=1`);
    },
  );
  const error = update.error ?? remove.error;

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          update.reset();
          remove.reset();
          form.reset({ name: list.name, memberAccess: list.memberAccess });
          setPanel("settings");
          setOpen(true);
        }}
        data-testid="shopping-list-settings"
      >
        {t("listSettings")}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title={
          panel === "archive"
            ? t("archiveTitle", { name: list.name })
            : panel === "delete"
              ? t("deleteListTitle", { name: list.name })
              : t("listSettingsTitle")
        }
        closeLabel={t("close")}
      >
        {panel === "settings" ? (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                update.mutate({ ...values, archived: list.archived });
              })(event);
            }}
          >
            <TextField
              label={t("fieldListName")}
              autoComplete="off"
              error={message(form.formState.errors.name?.message)}
              {...form.register("name")}
            />
            {homeId ? (
              <SelectField
                label={t("fieldMemberAccess")}
                description={t("fieldMemberAccessHint")}
                options={(["edit", "check", "view"] as const).map((value) => ({
                  value,
                  label: t(`access_${value}`),
                }))}
                data-testid="shopping-member-access"
                {...form.register("memberAccess")}
              />
            ) : null}
            {error ? (
              <FormAlert tone="error" announce>
                {error.failure === "conflict" ? t("listChangedMeanwhile") : failure(error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {list.archived ? (
                  <Button
                    variant="secondary"
                    loading={update.busy}
                    onClick={() => {
                      update.mutate({
                        name: list.name,
                        memberAccess: list.memberAccess,
                        archived: false,
                      });
                    }}
                    data-testid="shopping-list-unarchive"
                  >
                    {t("unarchive")}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPanel("archive");
                    }}
                    data-testid="shopping-list-archive"
                  >
                    {t("archive")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPanel("delete");
                  }}
                  data-testid="shopping-list-delete"
                >
                  {t("deleteList")}
                </Button>
              </div>
              <Button type="submit" loading={update.busy} data-testid="shopping-list-save">
                {t("save")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-body text-fg">
              {panel === "archive"
                ? t("archiveBody", { count: activeCount })
                : t("deleteListBody", { count: list.items.length })}
            </p>
            <p className="text-helper text-fg-muted">
              {panel === "archive" ? t("archiveWidgets") : t("deleteListWidgets")}
            </p>
            {error ? (
              <FormAlert tone="error" announce>
                {error.failure === "conflict" ? t("listChangedMeanwhile") : failure(error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setPanel("settings");
                }}
              >
                {t("cancel")}
              </Button>
              {panel === "archive" ? (
                <Button
                  loading={update.busy}
                  onClick={() => {
                    update.mutate({
                      name: list.name,
                      memberAccess: list.memberAccess,
                      archived: true,
                    });
                  }}
                  data-testid="shopping-list-archive-confirm"
                >
                  {t("archive")}
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  loading={remove.busy}
                  onClick={() => {
                    remove.mutate(undefined);
                  }}
                  data-testid="shopping-list-delete-confirm"
                >
                  {t("deleteList")}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
