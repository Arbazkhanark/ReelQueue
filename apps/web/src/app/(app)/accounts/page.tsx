// "use client";

// import { useState } from "react";
// import type { FormEvent } from "react";
// import { call, errorMessage } from "@/lib/api";
// import { invalidate, useApi } from "@/lib/use-api";
// import { formatDateTime } from "@/lib/format";
// import {
//   Badge,
//   Button,
//   Card,
//   ConfirmDialog,
//   EmptyState,
//   ErrorState,
//   Notice,
//   PageHeader,
//   SkeletonBlock,
//   TextField,
// } from "@/components/ui";
// import { AccountStatusBadge } from "@/components/status";
// import { useToast } from "@/components/toast";

// export default function AccountsPage() {
//   const accounts = useApi("listAccounts");
//   const dash = useApi("dashboard");
//   const toast = useToast();
//   const [username, setUsername] = useState("");
//   const [busy, setBusy] = useState<string | null>(null);
//   const [confirm, setConfirm] = useState<string | null>(null);
//   const mock = dash.data?.mockMode === true;

//   async function mockConnect(e: FormEvent) {
//     e.preventDefault();
//     if (!username.trim()) return;
//     setBusy("connect");
//     try {
//       await call("mockConnect", { body: { username: username.trim() } });
//       setUsername("");
//       invalidate("listAccounts", "dashboard");
//       toast.success("Mock account connected.");
//     } catch (x) {
//       toast.fail(x);
//     } finally {
//       setBusy(null);
//     }
//   }
//   async function connectReal() {
//     setBusy("connect");
//     try {
//       const r = await call("connectInstagram");
//       console.log("R.AuthoritionURL",r.authorizationUrl)
//       console.log("R FULL:", r);
//       window.location.assign(r.authorizationUrl);
//     } catch (x) {
//       toast.fail(x);
//       setBusy(null);
//     }
//   }
//   async function refreshQuota(id: string) {
//     setBusy(id);
//     try {
//       await call("refreshQuota", { params: { id } });
//       invalidate("listAccounts", "dashboard");
//       toast.success("Quota refreshed.");
//     } catch (x) {
//       toast.error(errorMessage(x));
//     } finally {
//       setBusy(null);
//     }
//   }
//   async function disconnect(id: string) {
//     setBusy(id);
//     try {
//       await call("disconnectAccount", { params: { id } });
//       invalidate("listAccounts", "dashboard");
//       toast.success("Account disconnected.");
//     } catch (x) {
//       toast.error(errorMessage(x));
//     } finally {
//       setBusy(null);
//       setConfirm(null);
//     }
//   }

//   return (
//     <>
//       <PageHeader
//         title="Instagram accounts"
//         description="Accounts are connected through Instagram’s official login. ReelQueue never sees your password."
//       />
//       {mock ? (
//         <Card title="Connect a mock account" className="mb-4">
//           <Notice tone="sim">
//             Simulation mode: a mock account never touches Instagram. Everything
//             published through it is labelled “Simulated”.
//           </Notice>
//           <form
//             onSubmit={mockConnect}
//             className="mt-3 flex flex-wrap items-end gap-2"
//           >
//             <TextField
//               label="Username"
//               value={username}
//               onChange={(e) => setUsername(e.target.value)}
//               className="min-w-56"
//             />
//             <Button
//               type="submit"
//               variant="primary"
//               loading={busy === "connect"}
//             >
//               Connect mock account
//             </Button>
//           </form>
//         </Card>
//       ) : (
//         <Card title="Connect Instagram" className="mb-4">
//           <p className="mb-2 text-sm text-muted">
//             Requires a professional (Business or Creator) Instagram account.
//           </p>
//           <Button
//             variant="primary"
//             loading={busy === "connect"}
//             onClick={() => void connectReal()}
//           >
//             Connect Instagram
//           </Button>
//         </Card>
//       )}
//       {accounts.error && !accounts.data ? (
//         <ErrorState
//           error={accounts.error}
//           onRetry={() => void accounts.reload()}
//         />
//       ) : !accounts.data ? (
//         <SkeletonBlock />
//       ) : accounts.data.length === 0 ? (
//         <EmptyState title="No accounts connected yet" />
//       ) : (
//         <ul className="space-y-3">
//           {accounts.data.map((a) => (
//             <li key={a.id}>
//               <Card>
//                 <div className="flex flex-wrap items-center justify-between gap-2">
//                   <div>
//                     <p className="font-semibold">
//                       @{a.username ?? "unknown"}{" "}
//                       {a.isMock ? <Badge tone="sim">Mock</Badge> : null}
//                     </p>
//                     <p className="text-xs text-muted">
//                       Connected {formatDateTime(a.createdAt)}
//                       {a.tokenExpiresAt
//                         ? ` · token expires ${formatDateTime(a.tokenExpiresAt)}`
//                         : ""}
//                     </p>
//                     <p className="text-sm">
//                       {a.quota
//                         ? `${a.quota.remaining} of ${a.quota.total} posts remaining in the current window (checked ${formatDateTime(a.quota.fetchedAt)})`
//                         : "Publishing quota not known yet."}
//                     </p>
//                     {a.lastErrorCode ? (
//                       <p className="text-xs text-danger">
//                         Last error: {a.lastErrorCode}
//                       </p>
//                     ) : null}
//                   </div>
//                   <div className="flex items-center gap-2">
//                     <AccountStatusBadge status={a.status} />
//                     <Button
//                       small
//                       loading={busy === a.id}
//                       onClick={() => void refreshQuota(a.id)}
//                     >
//                       Refresh quota
//                     </Button>
//                     <Button
//                       small
//                       variant="danger"
//                       onClick={() => setConfirm(a.id)}
//                     >
//                       Disconnect
//                     </Button>
//                   </div>
//                 </div>
//               </Card>
//             </li>
//           ))}
//         </ul>
//       )}
//       <ConfirmDialog
//         open={confirm !== null}
//         title="Disconnect this account?"
//         confirmLabel="Disconnect"
//         pending={busy === confirm}
//         onConfirm={() => {
//           if (confirm) void disconnect(confirm);
//         }}
//         onClose={() => setConfirm(null)}
//       >
//         Publishing to this account stops. A running cycle must be stopped first.
//       </ConfirmDialog>
//     </>
//   );
// }

















"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "next/navigation";

import { call, errorMessage } from "@/lib/api";
import { invalidate, useApi } from "@/lib/use-api";
import { formatDateTime } from "@/lib/format";

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SkeletonBlock,
  TextField,
} from "@/components/ui";

import { AccountStatusBadge } from "@/components/status";
import { useToast } from "@/components/toast";

const INSTAGRAM_ERRORS: Record<string, string> = {
  STATE_INVALID:
    "Instagram connection could not be verified or has expired. Please try again.",
  ACCESS_DENIED:
    "You denied Instagram access. Please try again if you want to connect.",
  SESSION:
    "Your session has expired. Please log in again.",
  NOT_ENABLED:
    "Instagram integration is currently unavailable.",
  NOT_PROFESSIONAL_ACCOUNT:
    "Instagram returned an unsupported account type. Check your account type and integration requirements.",
  TOKEN_EXCHANGE_FAILED:
    "Instagram authentication failed. Please try connecting again.",
  PROFILE_FETCH_FAILED:
    "We could not retrieve your Instagram profile.",
};

export default function AccountsPage() {
  const accounts = useApi("listAccounts");
  const dash = useApi("dashboard");
  const toast = useToast();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  // Prevent duplicate toasts from repeated effects/renders.
  const handledCallback = useRef<string | null>(null);

  const mock = dash.data?.mockMode === true;

  useEffect(() => {
    const error = searchParams.get("error");
    const connected = searchParams.get("connected");

    if (!error && connected !== "1") {
      handledCallback.current = null;
      return;
    }

    const callbackKey = error
      ? `error:${error}`
      : "connected:1";

    if (handledCallback.current === callbackKey) return;
    handledCallback.current = callbackKey;

    if (error) {
      toast.error(
        INSTAGRAM_ERRORS[error] ??
          `Instagram connection failed (${error}). Please try again.`
      );
    } else {
      toast.success("Instagram connected successfully!");
      invalidate("listAccounts", "dashboard");
    }
  }, [searchParams, toast]);

  async function mockConnect(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;

    setBusy("connect");

    try {
      await call("mockConnect", {
        body: { username: username.trim() },
      });

      setUsername("");
      invalidate("listAccounts", "dashboard");
      toast.success("Mock account connected.");
    } catch (x) {
      toast.fail(x);
    } finally {
      setBusy(null);
    }
  }

  async function connectReal() {
    setBusy("connect");

    try {
      const r = await call("connectInstagram");
      window.location.assign(r.authorizationUrl);
    } catch (x) {
      toast.fail(x);
      setBusy(null);
    }
  }

  async function refreshQuota(id: string) {
    setBusy(id);

    try {
      await call("refreshQuota", { params: { id } });
      invalidate("listAccounts", "dashboard");
      toast.success("Quota refreshed.");
    } catch (x) {
      toast.error(errorMessage(x));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string) {
    setBusy(id);

    try {
      await call("disconnectAccount", { params: { id } });
      invalidate("listAccounts", "dashboard");
      toast.success("Account disconnected.");
    } catch (x) {
      toast.error(errorMessage(x));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Instagram accounts"
        description="Accounts are connected through Instagram’s official login. ReelQueue never sees your password."
      />

      {mock ? (
        <Card title="Connect a mock account" className="mb-4">
          <Notice tone="sim">
            Simulation mode: a mock account never touches Instagram. Everything
            published through it is labelled “Simulated”.
          </Notice>

          <form
            onSubmit={mockConnect}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="min-w-56"
            />

            <Button
              type="submit"
              variant="primary"
              loading={busy === "connect"}
            >
              Connect mock account
            </Button>
          </form>
        </Card>
      ) : (
        <Card title="Connect Instagram" className="mb-4">
          <p className="mb-2 text-sm text-muted">
            Requires a professional (Business or Creator) Instagram account.
          </p>

          <Button
            variant="primary"
            loading={busy === "connect"}
            onClick={() => void connectReal()}
          >
            Connect Instagram
          </Button>
        </Card>
      )}

      {accounts.error && !accounts.data ? (
        <ErrorState
          error={accounts.error}
          onRetry={() => void accounts.reload()}
        />
      ) : !accounts.data ? (
        <SkeletonBlock />
      ) : accounts.data.length === 0 ? (
        <EmptyState title="No accounts connected yet" />
      ) : (
        <ul className="space-y-3">
          {accounts.data.map((a) => (
            <li key={a.id}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">
                      @{a.username ?? "unknown"}{" "}
                      {a.isMock ? <Badge tone="sim">Mock</Badge> : null}
                    </p>

                    <p className="text-xs text-muted">
                      Connected {formatDateTime(a.createdAt)}
                      {a.tokenExpiresAt
                        ? ` · token expires ${formatDateTime(a.tokenExpiresAt)}`
                        : ""}
                    </p>

                    <p className="text-sm">
                      {a.quota
                        ? `${a.quota.remaining} of ${a.quota.total} posts remaining in the current window (checked ${formatDateTime(a.quota.fetchedAt)})`
                        : "Publishing quota not known yet."}
                    </p>

                    {a.lastErrorCode ? (
                      <p className="text-xs text-danger">
                        Last error: {a.lastErrorCode}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    <AccountStatusBadge status={a.status} />

                    <Button
                      small
                      loading={busy === a.id}
                      onClick={() => void refreshQuota(a.id)}
                    >
                      Refresh quota
                    </Button>

                    <Button
                      small
                      variant="danger"
                      onClick={() => setConfirm(a.id)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title="Disconnect this account?"
        confirmLabel="Disconnect"
        pending={busy === confirm}
        onConfirm={() => {
          if (confirm) void disconnect(confirm);
        }}
        onClose={() => setConfirm(null)}
      >
        Publishing to this account stops. A running cycle must be stopped first.
      </ConfirmDialog>
    </>
  );
}
