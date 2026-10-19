/** Persist visible topic drafts without starting jobs or bypassing group approval. */
export async function materializeLibraryTopicDrafts(db: D1Database, workspaceId: string, siteId: string, resultId: string) {
  if (!resultId) return [];
  const result = await db.prepare('select id,status from topic_decision_results where id=? and workspace_id=? and site_id=?').bind(resultId, workspaceId, siteId).first<{ id: string; status: string }>();
  if (!result) throw new Error('Topic group is outside the authenticated site');
  const items = (await db.prepare('select id,topic_id,title_direction,content_type,primary_keyword,library_keyword_id,locale,relationship_to_existing from topic_decision_items where result_id=? and library_keyword_id is not null order by sort_order').bind(resultId).all<{id:string;topic_id:string|null;title_direction:string;content_type:string;primary_keyword:string;library_keyword_id:string;locale:string;relationship_to_existing:string}>()).results;
  for (const item of items) {
    const topicId = item.topic_id || `library-topic-${item.id}`;
    await db.batch([
      db.prepare("insert or ignore into topics(id,site_id,topic_key,title_hint,category,primary_keyword,status,created_at,decision_group_id,decision_item_id,plan_json) select ?,?,?,?,?,?,'draft',?,?,?,? where exists(select 1 from topic_decision_results where id=? and status='draft')")
        .bind(topicId, siteId, `library-${item.id}`, item.title_direction, item.content_type, item.primary_keyword, new Date().toISOString(), resultId, item.id, JSON.stringify({ locale: item.locale, library_keyword_id: item.library_keyword_id }), resultId),
      db.prepare('update topic_decision_items set topic_id=? where id=? and topic_id is null and exists(select 1 from topics where id=? and decision_item_id=?)').bind(topicId, item.id, topicId, item.id),
    ]);
  }
  return (await db.prepare('select i.topic_id,i.library_keyword_id,i.title_direction,i.locale from topic_decision_items i join topics t on t.id=i.topic_id where i.result_id=? and i.library_keyword_id is not null order by i.sort_order').bind(resultId).all()).results;
}
