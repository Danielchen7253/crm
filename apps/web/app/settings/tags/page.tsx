"use client";

import { useEffect, useMemo, useState } from "react";

type Tag = {
  id: string;
  name: string;
  groupName?: string | null;
  color?: string | null;
  description?: string | null;
  isActive: boolean;
  _count?: { customers: number };
};

const groups = [
  "Customer Identity",
  "Industry",
  "Occupation",
  "Product Interest",
  "Product Purchase",
  "Service Need",
  "Customer Level",
  "Region",
  "Language",
  "Marketing",
];

export default function TagsSettingsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", groupName: "Customer Identity", color: "#0f172a", description: "" });

  async function loadTags() {
    setLoading(true);
    const res = await fetch(`/api/backend/tags?active=true&q=${encodeURIComponent(q)}`, { cache: "no-store" });
    setTags(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    void loadTags();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, Tag[]>();
    for (const tag of tags) {
      const key = tag.groupName || "Other";
      map.set(key, [...(map.get(key) ?? []), tag]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tags]);

  async function seedDefaults() {
    await fetch("/api/backend/tags/seed-defaults", { method: "POST" });
    await loadTags();
  }

  async function createTag() {
    if (!form.name.trim()) return;
    await fetch("/api/backend/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm((current) => ({ ...current, name: "", description: "" }));
    await loadTags();
  }

  async function hideTag(id: string) {
    await fetch(`/api/backend/tags/${id}`, { method: "DELETE" });
    await loadTags();
  }

  return (
    <main className="tagSettings">
      <header className="tagSettingsHeader">
        <div>
          <h1>Customer Tags</h1>
          <p>Unlimited stackable tags for customer pools, follow-up, and campaigns.</p>
        </div>
        <button onClick={seedDefaults}>Load default tags</button>
      </header>

      <section className="tagCreate">
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          placeholder="New tag name"
        />
        <select value={form.groupName} onChange={(event) => setForm({ ...form, groupName: event.target.value })}>
          {groups.map((group) => (
            <option key={group}>{group}</option>
          ))}
        </select>
        <input
          type="color"
          value={form.color}
          onChange={(event) => setForm({ ...form, color: event.target.value })}
          aria-label="Tag color"
        />
        <input
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          placeholder="Description"
        />
        <button onClick={createTag}>Create</button>
      </section>

      <section className="tagSearch">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void loadTags();
          }}
          placeholder="Search tags, groups, descriptions"
        />
        <button onClick={loadTags}>Search</button>
      </section>

      {loading ? <p className="tagStatus">Loading tags...</p> : null}
      {!loading && grouped.length === 0 ? <p className="tagStatus">No tags found.</p> : null}

      <section className="tagGroups">
        {grouped.map(([groupName, items]) => (
          <div className="tagGroup" key={groupName}>
            <div className="tagGroupTitle">
              <h2>{groupName}</h2>
              <span>{items.length} tags</span>
            </div>
            <div className="tagGrid">
              {items.map((tag) => (
                <article className="tagCard" key={tag.id}>
                  <div className="tagCardMain">
                    <span className="tagDot" style={{ backgroundColor: tag.color ?? "#334155" }} />
                    <div>
                      <strong>{tag.name}</strong>
                      <p>{tag.description || "No description"}</p>
                    </div>
                  </div>
                  <div className="tagCardMeta">
                    <span>{tag._count?.customers ?? 0} customers</span>
                    <button onClick={() => hideTag(tag.id)}>Hide</button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
