// Courses arrive from the local workspace, never a bundled personal dataset.
export interface CourseTask {
  key: string;
  name: string;
  section: string;
  type: string;
  status: string;
  finished: boolean;
}
export interface Course {
  platform?: string;
  platformLabel?: string;
  id: string;
  title: string;
  tasks: CourseTask[];
  done: number;
  total: number;
  enabled: boolean;
  finished?: boolean;
  label?: string;
  sections?: {name:string;status:string;finished:boolean}[];
}
export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  courseCode: string;
  completed: number;
  total: number;
  course: Course;
}
export const archiveColumns = [
  "课程档案",
  "课程档案",
  "课程档案",
  "课程档案",
  "课程档案",
];
export const categories = ["全部课程", "课程档案"];
export const records: ArchiveRecord[] = [];
export let courseList: Course[] = [];
export function updateCourses(courses: Course[]) {
  courseList = courses;
  const list = courses.length
    ? courses
    : [
        {
          id: "",
          title: "还没有课程清单",
          tasks: [],
          done: 0,
          total: 0,
          enabled: false,
        },
      ];
  records.length = 0;
  for (let lane = 0; lane < 5; lane++)
    for (let i = 0; i < list.length; i++) {
      const c = list[i],
        code = String(i + 1).padStart(3, "0");
      records.push({
        id: `X-${String(lane * list.length + i + 1).padStart(3, "0")}`,
        title: c.title,
        en: "COURSE ARCHIVE",
        department: c.platformLabel || "学习通",
        category: "课程档案",
        date: "本机清单",
        lead: "",
        clearance: c.label || `${c.done} / ${c.total} 已完成`,
        abstract: "",
        findings: [],
        source: "",
        courseCode: code,
        completed: c.done,
        total: c.total,
        course: c,
      });
    }
}
updateCourses([]);
export function columnFiles(lane: number) {
  const size = records.length / 5;
  return Array.from(
    { length: size },
    (_, i) => (((lane % 5) + 5) % 5) * size + i,
  );
}
export function fileLocation(index: number) {
  const size = records.length / 5,
    lane = Math.floor(index / size),
    row = 12 + (index % size);
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / 32));
  return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
}
