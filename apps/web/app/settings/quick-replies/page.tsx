import { redirect } from "next/navigation";

export default function QuickRepliesSettingsPage() {
  redirect("/?settings=quick-replies");
}
