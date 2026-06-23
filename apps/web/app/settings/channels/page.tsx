import { redirect } from "next/navigation";

export default function ChannelsSettingsPage() {
  redirect("/?settings=channels");
}
