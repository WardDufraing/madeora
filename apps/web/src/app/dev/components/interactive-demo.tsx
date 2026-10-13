"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
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
