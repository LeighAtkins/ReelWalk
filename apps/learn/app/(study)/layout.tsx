import { TabBar, TopBar } from "@/components/Chrome";

export default function StudyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      <main className="page">{children}</main>
      <TabBar />
    </>
  );
}
