// Keep the complete section tree even when deep scanning skips completed sections.
export function reconMetadata(course) {
  const summary=course.summary;
  const valid=summary&&Number.isFinite(summary.done)&&Number.isFinite(summary.total)&&summary.done>=0&&summary.total>=summary.done;
  return {
    sectionTreeKnown:Array.isArray(course.sections)&&!course.error,
    scanError:course.error||null,
    platformSummary:valid?{done:summary.done,total:summary.total}:null,
    sections:(course.sections||[]).map(s=>({
      knowledgeId:s.knowledgeId,secNo:s.secNo,name:s.name,done:s.done===true,
      pending:s.jobPending??s.jobPendingFromTree??s.jobTotal??null,
      probed:Array.isArray(s.taskPoints)&&!s.taskPointError,
      scanError:s.taskPointError||null,
    })),
  };
}
