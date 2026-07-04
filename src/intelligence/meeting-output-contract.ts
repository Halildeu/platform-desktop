export const MEETING_OUTPUT_ADAPTER_CONTRACT_VERSION =
  'platform.erp-crm.meeting-output.v1' as const;
export const MEETING_OUTPUT_ADAPTER_PROFILE_ID = 'generic-erp-crm-meeting-output' as const;
export const MEETING_OUTPUT_ADAPTER_KIND = 'vendor-neutral-meeting-output-adapter' as const;
export const MEETING_OUTPUT_ADAPTER_TARGET = 'Generic ERP/CRM meeting workspace' as const;
export const MEETING_OUTPUT_SUPPORTED_OBJECTS = [
  'meeting_note',
  'decision_record',
  'action_task',
] as const;
export const MEETING_OUTPUT_ADAPTER_CAPABILITIES = [
  'upsert_meeting_note',
  'upsert_decision_record',
  'upsert_action_task',
  'source_reference_mapping',
  'idempotent_write',
  'human_review_gate',
] as const;
export const MEETING_OUTPUT_ADAPTER_OBJECT_CONTRACTS = [
  {
    object: 'meeting_note',
    operation: 'upsert',
    external_key: 'meeting_id',
    required_fields: ['display_title', 'summary_markdown'],
    optional_fields: ['citations', 'source_evidence'],
  },
  {
    object: 'decision_record',
    operation: 'upsert',
    external_key: 'decision.id',
    required_fields: ['decision.title', 'decision.owner', 'decision.status'],
    optional_fields: ['decision.citations'],
  },
  {
    object: 'action_task',
    operation: 'upsert',
    external_key: 'action.id',
    required_fields: ['action.title', 'action.assignee', 'action.status'],
    optional_fields: ['action.due_date', 'action.priority', 'action.citations'],
  },
] as const;
