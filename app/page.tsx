import { Chat } from "@/components/Chat";

/*
 * No coin here. The mark is the doorway *into* CoinBane, so it waits on the
 * landing page and stays behind once the user has walked through it — it is
 * mounted by app/paypal/page.tsx alone, never by this page or the layout.
 *
 * The microphone in the chat is its own button, in the composer.
 */
export default function Page() {
  return <Chat />;
}
