import { redirect } from "next/navigation";

export default function UsersSettingsPage() {
  redirect("/?settings=users");
}
