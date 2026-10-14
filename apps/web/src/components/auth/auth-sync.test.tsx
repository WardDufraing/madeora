import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";

import { announceSignedOut } from "@/auth/broadcast";

import { AuthSync } from "./auth-sync";

type Listener = (event: string, session: { user: { id: string } } | null) => void;
const listeners: Listener[] = [];
const refresh = vi.fn();

vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      onAuthStateChange: (listener: Listener) => {
        listeners.push(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

function setup(userId = "user-a") {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["private", "household"], { secret: true });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = render(<AuthSync userId={userId} />, { wrapper });
  return { queryClient, view, wrapper };
}

const cached = (queryClient: QueryClient) => queryClient.getQueryCache().getAll().length;

beforeEach(() => {
  listeners.length = 0;
  refresh.mockClear();
});

describe("AuthSync", () => {
  it("empties the query cache and re-checks access when this tab signs out", () => {
    const { queryClient } = setup();
    act(() => {
      for (const listener of listeners) listener("SIGNED_OUT", null);
    });
    expect(cached(queryClient)).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("empties the cache when a different account appears", () => {
    const { queryClient } = setup();
    act(() => {
      for (const listener of listeners) listener("TOKEN_REFRESHED", { user: { id: "user-a" } });
    });
    expect(cached(queryClient)).toBe(1);
    act(() => {
      for (const listener of listeners) listener("SIGNED_IN", { user: { id: "user-b" } });
    });
    expect(cached(queryClient)).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("empties the cache when the server confirms another account for the page", () => {
    const { queryClient, view } = setup();
    view.rerender(<AuthSync userId="user-a" />);
    expect(cached(queryClient)).toBe(1);
    view.rerender(<AuthSync userId="user-b" />);
    expect(cached(queryClient)).toBe(0);
  });

  it("empties the cache when another tab signs out", async () => {
    const { queryClient } = setup();
    announceSignedOut();
    await vi.waitFor(() => {
      expect(cached(queryClient)).toBe(0);
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
});
