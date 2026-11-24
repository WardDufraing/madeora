"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AdaptiveSwitcher } from "@/components/ui/adaptive-switcher";
import { Card } from "@/components/ui/card";
import { CreateDialog } from "@/components/ui/create-dialog";
import { Dialog } from "@/components/ui/dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Popover } from "@/components/ui/popover";
import { TextField } from "@/components/ui/text-field";
import { ToastProvider, useToast, type ToastTone } from "@/components/ui/toast";

export function InteractiveDemo() {
  return (
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      <Demo />
    </ToastProvider>
  );
}

const toastSamples: Record<ToastTone, { title: string; description: string }> = {
  info: { title: "Heads up", description: "This is an information message." },
  success: { title: "Saved", description: "Your changes are saved." },
  warning: { title: "Almost full", description: "You are close to your storage allowance." },
  error: { title: "Couldn't save", description: "Something went wrong. Try again." },
};

function Demo() {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  return (
    <Card title="Dialog and toasts">
      <div className="flex flex-wrap gap-3">
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Open dialog
        </Button>
        {(Object.keys(toastSamples) as ToastTone[]).map((tone) => (
          <Button
            key={tone}
            variant="secondary"
            onClick={() => {
              toast.show({ ...toastSamples[tone], tone });
            }}
          >
            Show {tone} toast
          </Button>
        ))}
        <Button
          variant="secondary"
          onClick={() => {
            toast.show({
              title: "Item deleted",
              action: { label: "Undo", onAction: () => undefined },
              duration: null,
            });
          }}
        >
          Show toast with action
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Example dialog"
        description="Dialogs keep focus inside until they close."
        closeLabel="Close"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-body">Press Escape, the close button, Cancel or Confirm to close it.</p>
      </Dialog>
    </Card>
  );
}

const demoLists = Array.from({ length: 9 }, (_, index) => ({
  id: `demo-${String(index)}`,
  label: `Demo list ${String(index + 1)}`,
}));

const discardPrompt = {
  title: "Discard changes?",
  message: "What you typed will be lost.",
  discard: "Discard",
  keep: "Keep editing",
};

/** Sample copy only: the redesign foundations (depth, priority hues, menus, switcher, creation). */
export function FoundationsDemo() {
  const [size, setSize] = useState<"compact" | "large" | "side" | null>(null);
  const [dirty, setDirty] = useState("");
  const [few, setFew] = useState("demo-0");
  const [many, setMany] = useState("demo-0");

  return (
    <div className="flex flex-col gap-6">
      <Card title="Depth roles">
        <div className="flex flex-wrap gap-4">
          {(["shadow-raised", "shadow-overlay", "shadow-inset", "shadow-selected"] as const).map(
            (role) => (
              <div
                key={role}
                className={`flex h-20 w-40 items-center justify-center rounded-card border border-line bg-surface text-helper ${role}`}
              >
                {role.replace("shadow-", "")}
              </div>
            ),
          )}
        </div>
      </Card>
      <Card title="Task priority hues">
        <ul className="flex flex-col gap-2">
          {(
            [
              ["High", "bg-priority-high"],
              ["Medium", "bg-priority-medium"],
              ["Low", "bg-priority-low"],
            ] as const
          ).map(([name, bar]) => (
            <li key={name} className="flex items-center gap-3">
              <span aria-hidden="true" className={`h-8 w-1 rounded-full ${bar}`} />
              <span className="text-body">{name} priority</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title="Menus and pickers"
        action={
          <OverflowMenu
            label="Card actions"
            items={[
              { id: "configure", label: "Configure", onSelect: () => undefined },
              { id: "remove", label: "Remove", onSelect: () => undefined, destructive: true },
            ]}
          />
        }
      >
        <div className="flex flex-col gap-4">
          <Popover label="Quick settings" trigger="Quick settings">
            <p className="text-body">Quick settings live here.</p>
          </Popover>
          <AdaptiveSwitcher
            label="Few lists"
            items={demoLists.slice(0, 3)}
            value={few}
            onChange={setFew}
            createLabel="New list"
            onCreate={() => undefined}
            searchLabel="Search lists"
            noResultsLabel="No lists found"
            pickerLabel="Choose list"
          />
          <AdaptiveSwitcher
            label="Many lists"
            items={demoLists}
            value={many}
            onChange={setMany}
            createLabel="New list"
            onCreate={() => undefined}
            searchLabel="Search lists"
            noResultsLabel="No lists found"
            pickerLabel="Choose list"
          />
        </div>
      </Card>
      <Card title="Adaptive creation">
        <div className="flex flex-wrap gap-3">
          {(["compact", "large", "side"] as const).map((value) => (
            <Button
              key={value}
              variant="secondary"
              onClick={() => {
                setSize(value);
              }}
            >
              Open {value} creation
            </Button>
          ))}
        </div>
        <CreateDialog
          open={size !== null}
          onClose={() => {
            setSize(null);
            setDirty("");
          }}
          size={size ?? "compact"}
          title="New item"
          closeLabel="Close"
          submitLabel="Save"
          cancelLabel="Cancel"
          dirty={dirty !== ""}
          discardPrompt={discardPrompt}
          onSubmit={() => {
            setSize(null);
            setDirty("");
          }}
        >
          <TextField
            label="Title"
            value={dirty}
            onChange={(event) => {
              setDirty(event.target.value);
            }}
          />
        </CreateDialog>
      </Card>
    </div>
  );
}
