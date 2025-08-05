import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import toc from "@/data/title17-toc.json";
import sections from "@/data/title17-sections.json";

export default function Title17Page() {
  const [activeSection, setActiveSection] = useState("106");
  const [search, setSearch] = useState("");
  const sectionData = sections.find((s) => s.section_number === activeSection);
  const filteredTOC = toc.filter(
    (entry) => entry.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r p-4 bg-white">
        <h2 className="text-xl font-semibold mb-2">Table of Contents</h2>
        <Input
          placeholder="Search TOC..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3"
        />
        <ScrollArea className="h-[85vh]">
          <ul className="space-y-2">
            {filteredTOC.map((entry) => (
              <li key={entry.section_number}>
                <button
                  className={`text-left w-full hover:underline ${
                    activeSection === entry.section_number ? "font-bold" : ""
                  }`}
                  onClick={() => setActiveSection(entry.section_number)}
                >
                  § {entry.section_number} — {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </aside>
      <main className="flex-1 p-6">
        {sectionData ? (
          <Card>
            <CardContent className="prose max-w-none">
              <h1 id={`§${sectionData.section_number}`}>
                § {sectionData.section_number} — {sectionData.title}
              </h1>
              {sectionData.paragraphs.map((p, i) => (
                <p key={i} id={`§${sectionData.section_number}.${i + 1}`}>
                  <a
                    href={`#§${sectionData.section_number}.${i + 1}`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    ¶ {i + 1}
                  </a>{" "}
                  {p}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : (
          <p>Section not found.</p>
        )}
      </main>
    </div>
  );
}
