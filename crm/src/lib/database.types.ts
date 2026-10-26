
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "public": {
          Tables: {
            "access_grants": {
                  Row: {
                    "branch_id": string | null,"created_at": string,"expires_at": string | null,"granted_by": string,"id": string,"legal_entity_id": string,"permission_code": string,"reason": string,"revocation_reason": string | null,"revoked_at": string | null,"revoked_by": string | null,"starts_at": string,"user_id": string
                  }
                  Insert: {
                    "branch_id"?: string | null,"created_at"?: string,"expires_at"?: string | null,"granted_by": string,"id"?: string,"legal_entity_id": string,"permission_code": string,"reason": string,"revocation_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"starts_at"?: string,"user_id": string
                  }
                  Update: {
                    "branch_id"?: string | null,"created_at"?: string,"expires_at"?: string | null,"granted_by"?: string,"id"?: string,"legal_entity_id"?: string,"permission_code"?: string,"reason"?: string,"revocation_reason"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"starts_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "access_grants_granted_by_fkey"
      columns: ["granted_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "access_grants_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "access_grants_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "access_grants_permission_code_fkey"
      columns: ["permission_code"]
isOneToOne: false
      referencedRelation: "permissions"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "access_grants_revoked_by_fkey"
      columns: ["revoked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "access_grants_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"accounts_booking_reviews": {
                  Row: {
                    "booking_version_id": string,"created_at": string,"deal_id": string,"id": string,"legal_entity_id": string,"reason_shared_with_sales": boolean,"return_reason": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"row_version": number,"status": string,"updated_at": string
                  }
                  Insert: {
                    "booking_version_id": string,"created_at"?: string,"deal_id": string,"id"?: string,"legal_entity_id": string,"reason_shared_with_sales"?: boolean,"return_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"row_version"?: number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "booking_version_id"?: string,"created_at"?: string,"deal_id"?: string,"id"?: string,"legal_entity_id"?: string,"reason_shared_with_sales"?: boolean,"return_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"row_version"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "accounts_booking_reviews_legal_entity_id_deal_id_booking_v_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "accounts_booking_reviews_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"audit_events": {
                  Row: {
                    "action": string,"actor_user_id": string | null,"branch_id": string | null,"details": NonNullable<Json>,"id": number,"legal_entity_id": string | null,"occurred_at": string,"reason": string | null,"sensitivity": string,"target_id": string | null,"target_type": string
                  }
                  Insert: {
                    "action": string,"actor_user_id"?: string | null,"branch_id"?: string | null,"details"?: NonNullable<Json>,"id"?: never,"legal_entity_id"?: string | null,"occurred_at"?: string,"reason"?: string | null,"sensitivity"?: string,"target_id"?: string | null,"target_type": string
                  }
                  Update: {
                    "action"?: string,"actor_user_id"?: string | null,"branch_id"?: string | null,"details"?: NonNullable<Json>,"id"?: never,"legal_entity_id"?: string | null,"occurred_at"?: string,"reason"?: string | null,"sensitivity"?: string,"target_id"?: string | null,"target_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_events_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"bitrix_customer_type_options": {
                  Row: {
                    "code": string,"enum_id": string,"source_object": string
                  }
                  Insert: {
                    "code": string,"enum_id": string,"source_object": string
                  }
                  Update: {
                    "code"?: string,"enum_id"?: string,"source_object"?: string
                  }
                  Relationships: [

                  ]
                },"bitrix_destination_scopes": {
                  Row: {
                    "created_at": string,"legal_entity_id": string,"list_entity_id": string,"option_id": string,"reason": string,"row_version": number,"scope": string | null,"set_at": string,"set_by": string,"source_portal": string
                  }
                  Insert: {
                    "created_at"?: string,"legal_entity_id": string,"list_entity_id": string,"option_id": string,"reason": string,"row_version"?: number,"scope"?: string | null,"set_at"?: string,"set_by": string,"source_portal": string
                  }
                  Update: {
                    "created_at"?: string,"legal_entity_id"?: string,"list_entity_id"?: string,"option_id"?: string,"reason"?: string,"row_version"?: number,"scope"?: string | null,"set_at"?: string,"set_by"?: string,"source_portal"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bitrix_destination_scopes_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bitrix_destination_scopes_set_by_fkey"
      columns: ["set_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"bitrix_id_proof_copy_jobs": {
                  Row: {
                    "attempts": number,"bitrix_file_id": number | null,"created_at": string,"deal_id": string,"file_sha256": string,"id": string,"id_proof_id": string,"last_error_code": string | null,"lease_token": string | null,"legal_entity_id": string,"locked_until": string | null,"max_attempts": number,"next_attempt_at": string,"prior_file_ids": (number)[] | null,"read_back_attempts": number,"sent_at": string | null,"source_deal_id": number,"source_portal": string,"status": string,"traveller_id": string,"updated_at": string
                  }
                  Insert: {
                    "attempts"?: number,"bitrix_file_id"?: number | null,"created_at"?: string,"deal_id": string,"file_sha256": string,"id"?: string,"id_proof_id": string,"last_error_code"?: string | null,"lease_token"?: string | null,"legal_entity_id": string,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"prior_file_ids"?: (number)[] | null,"read_back_attempts"?: number,"sent_at"?: string | null,"source_deal_id": number,"source_portal": string,"status"?: string,"traveller_id": string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"bitrix_file_id"?: number | null,"created_at"?: string,"deal_id"?: string,"file_sha256"?: string,"id"?: string,"id_proof_id"?: string,"last_error_code"?: string | null,"lease_token"?: string | null,"legal_entity_id"?: string,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string,"prior_file_ids"?: (number)[] | null,"read_back_attempts"?: number,"sent_at"?: string | null,"source_deal_id"?: number,"source_portal"?: string,"status"?: string,"traveller_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bitrix_id_proof_copy_jobs_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bitrix_id_proof_copy_jobs_id_proof_id_fkey"
      columns: ["id_proof_id"]
isOneToOne: false
      referencedRelation: "traveller_id_proofs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bitrix_id_proof_copy_jobs_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"bitrix_id_proof_copy_stops": {
                  Row: {
                    "acknowledged_at": string | null,"acknowledged_by": string | null,"id": string,"job_id": string,"legal_entity_id": string,"opened_at": string,"portal_member_id": string,"reason_code": string,"source_deal_id": number
                  }
                  Insert: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"id"?: string,"job_id": string,"legal_entity_id": string,"opened_at"?: string,"portal_member_id": string,"reason_code": string,"source_deal_id": number
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"id"?: string,"job_id"?: string,"legal_entity_id"?: string,"opened_at"?: string,"portal_member_id"?: string,"reason_code"?: string,"source_deal_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "bitrix_id_proof_copy_stops_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "bitrix_id_proof_copy_jobs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bitrix_id_proof_copy_stops_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "bitrix_id_proof_copy_stops_portal_member_id_fkey"
      columns: ["portal_member_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["portal_member_id"]
    }
                  ]
                },"bitrix_name_lists": {
                  Row: {
                    "code": string,"created_at": string,"entity_id": string,"id": string,"kind": string | null,"missing_since": string | null,"name": string,"read_at": string,"sort": number,"source_portal": string,"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"entity_id": string,"id"?: string,"kind"?: string | null,"missing_since"?: string | null,"name": string,"read_at"?: string,"sort"?: number,"source_portal": string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"entity_id"?: string,"id"?: string,"kind"?: string | null,"missing_since"?: string | null,"name"?: string,"read_at"?: string,"sort"?: number,"source_portal"?: string,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"bitrix_name_refresh_state": {
                  Row: {
                    "last_attempt_at": string | null,"last_success_at": string | null,"source_portal": string,"updated_at": string
                  }
                  Insert: {
                    "last_attempt_at"?: string | null,"last_success_at"?: string | null,"source_portal": string,"updated_at"?: string
                  }
                  Update: {
                    "last_attempt_at"?: string | null,"last_success_at"?: string | null,"source_portal"?: string,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"bitrix_party_snapshots": {
                  Row: {
                    "created_at": string,"display_name": string | null,"emails": (string)[],"id": string,"legal_entity_id": string,"party_kind": string,"phones": (string)[],"read_at": string,"source_modified_at": string | null,"source_party_id": number,"source_portal": string
                  }
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"emails"?: (string)[],"id"?: string,"legal_entity_id": string,"party_kind": string,"phones"?: (string)[],"read_at"?: string,"source_modified_at"?: string | null,"source_party_id": number,"source_portal": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"emails"?: (string)[],"id"?: string,"legal_entity_id"?: string,"party_kind"?: string,"phones"?: (string)[],"read_at"?: string,"source_modified_at"?: string | null,"source_party_id"?: number,"source_portal"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bitrix_party_snapshots_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"bitrix_user_mappings": {
                  Row: {
                    "active": boolean,"bitrix_user_id": number,"created_at": string,"created_by": string | null,"id": string,"portal_member_id": string,"staff_user_id": string,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "active"?: boolean,"bitrix_user_id": number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"portal_member_id": string,"staff_user_id": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"bitrix_user_id"?: number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"portal_member_id"?: string,"staff_user_id"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "bitrix_user_mappings_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "bitrix_user_mappings_portal_member_id_fkey"
      columns: ["portal_member_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["portal_member_id"]
    },{
      foreignKeyName: "bitrix_user_mappings_staff_user_id_fkey"
      columns: ["staff_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "bitrix_user_mappings_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"booking_evidence": {
                  Row: {
                    "created_at": string,"deal_id": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string,"version_id": string
                  }
                  Insert: {
                    "created_at"?: string,"deal_id": string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string,"version_id": string
                  }
                  Update: {
                    "created_at"?: string,"deal_id"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_evidence_legal_entity_id_deal_id_version_id_fkey"
      columns: ["legal_entity_id","deal_id","version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_evidence_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"booking_settings": {
                  Row: {
                    "evidence_max_bytes": number,"id": boolean,"real_booking_enabled": boolean,"updated_at": string
                  }
                  Insert: {
                    "evidence_max_bytes"?: number,"id"?: boolean,"real_booking_enabled"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "evidence_max_bytes"?: number,"id"?: boolean,"real_booking_enabled"?: boolean,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"booking_version_commercials": {
                  Row: {
                    "currency": string,"discount_paise": number | null,"legal_entity_id": string,"list_price_paise": number | null,"selling_total_paise": number,"updated_at": string,"version_id": string
                  }
                  Insert: {
                    "currency"?: string,"discount_paise"?: number | null,"legal_entity_id": string,"list_price_paise"?: number | null,"selling_total_paise": number,"updated_at"?: string,"version_id": string
                  }
                  Update: {
                    "currency"?: string,"discount_paise"?: number | null,"legal_entity_id"?: string,"list_price_paise"?: number | null,"selling_total_paise"?: number,"updated_at"?: string,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_commercials_legal_entity_id_version_id_fkey"
      columns: ["legal_entity_id","version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"booking_version_contacts": {
                  Row: {
                    "booking_for": string,"booking_version_id": string,"confirmed_at": string | null,"confirmed_by": string | null,"contact_confirmed": boolean,"contact_name": string,"created_at": string,"customer_type": string | null,"deal_id": string,"email": string | null,"legal_entity_id": string,"market": string | null,"mobile": string | null,"payer_different": boolean,"payer_name": string | null,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "booking_for": string,"booking_version_id": string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"contact_confirmed"?: boolean,"contact_name": string,"created_at"?: string,"customer_type"?: string | null,"deal_id": string,"email"?: string | null,"legal_entity_id": string,"market"?: string | null,"mobile"?: string | null,"payer_different"?: boolean,"payer_name"?: string | null,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "booking_for"?: string,"booking_version_id"?: string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"contact_confirmed"?: boolean,"contact_name"?: string,"created_at"?: string,"customer_type"?: string | null,"deal_id"?: string,"email"?: string | null,"legal_entity_id"?: string,"market"?: string | null,"mobile"?: string | null,"payer_different"?: boolean,"payer_name"?: string | null,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_contacts_confirmed_by_fkey"
      columns: ["confirmed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "booking_version_contacts_legal_entity_id_deal_id_booking_v_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_version_contacts_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"booking_version_instalments": {
                  Row: {
                    "amount_paise": number,"booking_version_id": string,"created_at": string,"deal_id": string,"due_date": string,"id": string,"label": string,"legal_entity_id": string,"seq": number
                  }
                  Insert: {
                    "amount_paise": number,"booking_version_id": string,"created_at"?: string,"deal_id": string,"due_date": string,"id"?: string,"label": string,"legal_entity_id": string,"seq": number
                  }
                  Update: {
                    "amount_paise"?: number,"booking_version_id"?: string,"created_at"?: string,"deal_id"?: string,"due_date"?: string,"id"?: string,"label"?: string,"legal_entity_id"?: string,"seq"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_instalments_legal_entity_id_deal_id_bookin_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    }
                  ]
                },"booking_version_price_lines": {
                  Row: {
                    "booking_version_id": string,"category": string,"created_at": string,"deal_id": string,"legal_entity_id": string,"markup_paise": number | null,"purchase_paise": number | null,"quantity": number,"sale_paise": number | null,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "booking_version_id": string,"category": string,"created_at"?: string,"deal_id": string,"legal_entity_id": string,"markup_paise"?: never,"purchase_paise"?: number | null,"quantity": number,"sale_paise"?: number | null,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "booking_version_id"?: string,"category"?: string,"created_at"?: string,"deal_id"?: string,"legal_entity_id"?: string,"markup_paise"?: never,"purchase_paise"?: number | null,"quantity"?: number,"sale_paise"?: number | null,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_price_lines_legal_entity_id_deal_id_bookin_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_version_price_lines_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"booking_version_traveller_identities": {
                  Row: {
                    "booking_version_id": string,"created_at": string,"date_of_birth": string | null,"legal_entity_id": string,"nationality": string | null,"passport_expiry": string | null,"passport_number": string | null,"seq": number
                  }
                  Insert: {
                    "booking_version_id": string,"created_at"?: string,"date_of_birth"?: string | null,"legal_entity_id": string,"nationality"?: string | null,"passport_expiry"?: string | null,"passport_number"?: string | null,"seq": number
                  }
                  Update: {
                    "booking_version_id"?: string,"created_at"?: string,"date_of_birth"?: string | null,"legal_entity_id"?: string,"nationality"?: string | null,"passport_expiry"?: string | null,"passport_number"?: string | null,"seq"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_traveller_ide_legal_entity_id_booking_vers_fkey"
      columns: ["legal_entity_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"booking_version_travellers": {
                  Row: {
                    "age_years": number | null,"booking_version_id": string,"created_at": string,"full_name": string,"id": string,"legal_entity_id": string,"seq": number,"special_needs": string | null,"special_requests": (string)[],"traveller_type": string
                  }
                  Insert: {
                    "age_years"?: number | null,"booking_version_id": string,"created_at"?: string,"full_name": string,"id"?: string,"legal_entity_id": string,"seq": number,"special_needs"?: string | null,"special_requests"?: (string)[],"traveller_type": string
                  }
                  Update: {
                    "age_years"?: number | null,"booking_version_id"?: string,"created_at"?: string,"full_name"?: string,"id"?: string,"legal_entity_id"?: string,"seq"?: number,"special_needs"?: string | null,"special_requests"?: (string)[],"traveller_type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_version_travellers_legal_entity_id_booking_version_fkey"
      columns: ["legal_entity_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"booking_versions": {
                  Row: {
                    "acceptance_from_version_id": string | null,"adults": number | null,"adults_count": number | null,"branch_id": string,"change_class": string | null,"changed_fields": (string)[] | null,"check_in": string | null,"check_out": string | null,"children": number | null,"children_count": number | null,"city": string | null,"commercial_revision": string,"confirmed_at": string | null,"confirmed_by": string | null,"confirmed_deal_source_modified_at": string | null,"content_hash": string,"created_at": string,"created_by": string,"deal_id": string,"discarded_at": string | null,"discarded_by": string | null,"form_rules": number,"hash_schema": number,"hotel_name": string | null,"id": string,"inclusions": string | null,"infants_count": number | null,"legal_entity_id": string,"meal_plan": string | null,"pax_total": number | null,"purchase_budget_paise": number | null,"revises_version_id": string | null,"room_type": string | null,"rooms": number | null,"row_version": number,"service_type": string,"source_accepted_tier": string | null,"source_quotation_hash": string | null,"source_quotation_version_id": string | null,"special_requests": string | null,"status": string,"superseded_at": string | null,"superseded_by_version_id": string | null,"trip_destination": string | null,"trip_end": string | null,"trip_scope": string | null,"trip_start": string | null,"updated_at": string,"updated_by": string | null,"version_no": number
                  }
                  Insert: {
                    "acceptance_from_version_id"?: string | null,"adults"?: number | null,"adults_count"?: number | null,"branch_id": string,"change_class"?: string | null,"changed_fields"?: (string)[] | null,"check_in"?: string | null,"check_out"?: string | null,"children"?: number | null,"children_count"?: number | null,"city"?: string | null,"commercial_revision"?: string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"confirmed_deal_source_modified_at"?: string | null,"content_hash": string,"created_at"?: string,"created_by": string,"deal_id": string,"discarded_at"?: string | null,"discarded_by"?: string | null,"form_rules"?: number,"hash_schema"?: number,"hotel_name"?: string | null,"id"?: string,"inclusions"?: string | null,"infants_count"?: number | null,"legal_entity_id": string,"meal_plan"?: string | null,"pax_total"?: number | null,"purchase_budget_paise"?: number | null,"revises_version_id"?: string | null,"room_type"?: string | null,"rooms"?: number | null,"row_version"?: number,"service_type"?: string,"source_accepted_tier"?: string | null,"source_quotation_hash"?: string | null,"source_quotation_version_id"?: string | null,"special_requests"?: string | null,"status"?: string,"superseded_at"?: string | null,"superseded_by_version_id"?: string | null,"trip_destination"?: string | null,"trip_end"?: string | null,"trip_scope"?: string | null,"trip_start"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"version_no": number
                  }
                  Update: {
                    "acceptance_from_version_id"?: string | null,"adults"?: number | null,"adults_count"?: number | null,"branch_id"?: string,"change_class"?: string | null,"changed_fields"?: (string)[] | null,"check_in"?: string | null,"check_out"?: string | null,"children"?: number | null,"children_count"?: number | null,"city"?: string | null,"commercial_revision"?: string,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"confirmed_deal_source_modified_at"?: string | null,"content_hash"?: string,"created_at"?: string,"created_by"?: string,"deal_id"?: string,"discarded_at"?: string | null,"discarded_by"?: string | null,"form_rules"?: number,"hash_schema"?: number,"hotel_name"?: string | null,"id"?: string,"inclusions"?: string | null,"infants_count"?: number | null,"legal_entity_id"?: string,"meal_plan"?: string | null,"pax_total"?: number | null,"purchase_budget_paise"?: number | null,"revises_version_id"?: string | null,"room_type"?: string | null,"rooms"?: number | null,"row_version"?: number,"service_type"?: string,"source_accepted_tier"?: string | null,"source_quotation_hash"?: string | null,"source_quotation_version_id"?: string | null,"special_requests"?: string | null,"status"?: string,"superseded_at"?: string | null,"superseded_by_version_id"?: string | null,"trip_destination"?: string | null,"trip_end"?: string | null,"trip_scope"?: string | null,"trip_start"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_versions_acceptance_from_fk"
      columns: ["legal_entity_id","deal_id","acceptance_from_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_versions_confirmed_by_fkey"
      columns: ["confirmed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "booking_versions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "booking_versions_discarded_by_fkey"
      columns: ["discarded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "booking_versions_legal_entity_id_branch_id_deal_id_fkey"
      columns: ["legal_entity_id","branch_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","branch_id","id"]
    },{
      foreignKeyName: "booking_versions_revises_fk"
      columns: ["legal_entity_id","deal_id","revises_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_versions_source_quotation_version_id_fkey"
      columns: ["source_quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "booking_versions_superseded_by_fk"
      columns: ["legal_entity_id","deal_id","superseded_by_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "booking_versions_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"branches": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_head_office": boolean,"legal_entity_id": string,"name": string,"state_name": string,"status": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_head_office"?: boolean,"legal_entity_id": string,"name": string,"state_name": string,"status"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_head_office"?: boolean,"legal_entity_id"?: string,"name"?: string,"state_name"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "branches_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"cash_deposit_items": {
                  Row: {
                    "amount_paise": number,"deposit_id": string,"legal_entity_id": string,"receipt_id": string,"released": boolean
                  }
                  Insert: {
                    "amount_paise": number,"deposit_id": string,"legal_entity_id": string,"receipt_id": string,"released"?: boolean
                  }
                  Update: {
                    "amount_paise"?: number,"deposit_id"?: string,"legal_entity_id"?: string,"receipt_id"?: string,"released"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_deposit_items_deposit_id_fkey"
      columns: ["deposit_id"]
isOneToOne: false
      referencedRelation: "cash_deposits"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_deposit_items_receipt_id_fkey"
      columns: ["receipt_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id"]
    }
                  ]
                },"cash_deposits": {
                  Row: {
                    "bank_reference": string,"branch_id": string,"deposited_on": string,"id": string,"legal_entity_id": string,"recorded_at": string,"recorded_by": string,"reject_reason": string | null,"rejected_at": string | null,"rejected_by": string | null,"request_id": string,"status": string,"total_paise": number,"updated_at": string,"verified_at": string | null,"verified_by": string | null
                  }
                  Insert: {
                    "bank_reference": string,"branch_id": string,"deposited_on": string,"id"?: string,"legal_entity_id": string,"recorded_at"?: string,"recorded_by": string,"reject_reason"?: string | null,"rejected_at"?: string | null,"rejected_by"?: string | null,"request_id": string,"status"?: string,"total_paise": number,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "bank_reference"?: string,"branch_id"?: string,"deposited_on"?: string,"id"?: string,"legal_entity_id"?: string,"recorded_at"?: string,"recorded_by"?: string,"reject_reason"?: string | null,"rejected_at"?: string | null,"rejected_by"?: string | null,"request_id"?: string,"status"?: string,"total_paise"?: number,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_deposits_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "cash_deposits_recorded_by_fkey"
      columns: ["recorded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "cash_deposits_rejected_by_fkey"
      columns: ["rejected_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "cash_deposits_verified_by_fkey"
      columns: ["verified_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"cash_reconciliations": {
                  Row: {
                    "branch_id": string,"business_date": string,"counted_paise": number,"expected_paise": number,"id": string,"legal_entity_id": string,"note": string | null,"recorded_at": string,"recorded_by": string,"request_id": string,"stale": boolean,"stale_at": string | null,"status": string,"unverified_cash_paise": number,"updated_at": string,"verified_at": string | null,"verified_by": string | null
                  }
                  Insert: {
                    "branch_id": string,"business_date": string,"counted_paise": number,"expected_paise": number,"id"?: string,"legal_entity_id": string,"note"?: string | null,"recorded_at"?: string,"recorded_by": string,"request_id": string,"stale"?: boolean,"stale_at"?: string | null,"status"?: string,"unverified_cash_paise": number,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "branch_id"?: string,"business_date"?: string,"counted_paise"?: number,"expected_paise"?: number,"id"?: string,"legal_entity_id"?: string,"note"?: string | null,"recorded_at"?: string,"recorded_by"?: string,"request_id"?: string,"stale"?: boolean,"stale_at"?: string | null,"status"?: string,"unverified_cash_paise"?: number,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_reconciliations_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "cash_reconciliations_recorded_by_fkey"
      columns: ["recorded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "cash_reconciliations_verified_by_fkey"
      columns: ["verified_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"company_destination_versions": {
                  Row: {
                    "account_number": string | null,"bank_name": string | null,"created_at": string,"decided_at": string | null,"decided_by": string | null,"decision_reason": string | null,"destination_id": string,"holder_name": string | null,"id": string,"ifsc": string | null,"legal_entity_id": string,"maker": string,"payee_name": string | null,"predecessor_version_id": string | null,"request_id": string,"status": string,"upi_id": string | null,"version_no": number
                  }
                  Insert: {
                    "account_number"?: string | null,"bank_name"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_reason"?: string | null,"destination_id": string,"holder_name"?: string | null,"id"?: string,"ifsc"?: string | null,"legal_entity_id": string,"maker": string,"payee_name"?: string | null,"predecessor_version_id"?: string | null,"request_id": string,"status"?: string,"upi_id"?: string | null,"version_no": number
                  }
                  Update: {
                    "account_number"?: string | null,"bank_name"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_reason"?: string | null,"destination_id"?: string,"holder_name"?: string | null,"id"?: string,"ifsc"?: string | null,"legal_entity_id"?: string,"maker"?: string,"payee_name"?: string | null,"predecessor_version_id"?: string | null,"request_id"?: string,"status"?: string,"upi_id"?: string | null,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_destination_versions_decided_by_fkey"
      columns: ["decided_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "company_destination_versions_legal_entity_id_destination_i_fkey"
      columns: ["legal_entity_id","destination_id"]
isOneToOne: false
      referencedRelation: "company_destinations"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "company_destination_versions_maker_fkey"
      columns: ["maker"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "company_destination_versions_predecessor_version_id_fkey"
      columns: ["predecessor_version_id"]
isOneToOne: false
      referencedRelation: "company_destination_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"company_destinations": {
                  Row: {
                    "created_at": string,"created_by": string,"current_version_id": string | null,"id": string,"is_synthetic": boolean,"kind": string,"label": string,"legal_entity_id": string,"retire_reason": string | null,"retired_at": string | null,"retired_by": string | null,"row_version": number,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by": string,"current_version_id"?: string | null,"id"?: string,"is_synthetic": boolean,"kind": string,"label": string,"legal_entity_id": string,"retire_reason"?: string | null,"retired_at"?: string | null,"retired_by"?: string | null,"row_version"?: number,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"current_version_id"?: string | null,"id"?: string,"is_synthetic"?: boolean,"kind"?: string,"label"?: string,"legal_entity_id"?: string,"retire_reason"?: string | null,"retired_at"?: string | null,"retired_by"?: string | null,"row_version"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_destinations_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "company_destinations_current_version_fk"
      columns: ["id","current_version_id"]
isOneToOne: false
      referencedRelation: "company_destination_versions"
      referencedColumns: ["destination_id","id"]
    },{
      foreignKeyName: "company_destinations_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "company_destinations_retired_by_fkey"
      columns: ["retired_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"crm_leads": {
                  Row: {
                    "branch_id": string,"created_at": string,"id": string,"intake_inbox_id": string,"intake_mode": string,"last_synced_at": string,"last_verified_at": string,"legal_entity_id": string,"manifest_id": string | null,"owner_user_id": string | null,"reference": string,"source_assigned_by_id": number | null,"source_created_at": string,"source_id_code": string,"source_lead_id": number,"source_modified_at": string,"source_portal": string,"source_status_id": string,"source_system": string,"title": string
                  }
                  Insert: {
                    "branch_id": string,"created_at"?: string,"id"?: string,"intake_inbox_id": string,"intake_mode"?: string,"last_synced_at": string,"last_verified_at": string,"legal_entity_id": string,"manifest_id"?: string | null,"owner_user_id"?: string | null,"reference": string,"source_assigned_by_id"?: number | null,"source_created_at": string,"source_id_code": string,"source_lead_id": number,"source_modified_at": string,"source_portal": string,"source_status_id": string,"source_system"?: string,"title": string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"id"?: string,"intake_inbox_id"?: string,"intake_mode"?: string,"last_synced_at"?: string,"last_verified_at"?: string,"legal_entity_id"?: string,"manifest_id"?: string | null,"owner_user_id"?: string | null,"reference"?: string,"source_assigned_by_id"?: number | null,"source_created_at"?: string,"source_id_code"?: string,"source_lead_id"?: number,"source_modified_at"?: string,"source_portal"?: string,"source_status_id"?: string,"source_system"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "crm_leads_intake_inbox_id_fkey"
      columns: ["intake_inbox_id"]
isOneToOne: false
      referencedRelation: "integration_inbox"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "crm_leads_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "crm_leads_manifest_id_fkey"
      columns: ["manifest_id"]
isOneToOne: false
      referencedRelation: "intake_manifests"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "crm_leads_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"customer_billing_profiles": {
                  Row: {
                    "address_line1": string,"address_line2": string | null,"bill_to_type": string | null,"billing_name": string,"city": string,"contact_person": string | null,"created_at": string,"deal_id": string,"email": string | null,"gst_reason": string | null,"gst_status": string | null,"gstin": string | null,"legal_entity_id": string,"party_copied_at": string | null,"party_id": string | null,"phone": string | null,"postal_code": string,"prefill_source": string,"row_version": number,"state_code": string,"status": string,"updated_at": string,"updated_by": string,"verified_at": string | null,"verified_by": string | null
                  }
                  Insert: {
                    "address_line1": string,"address_line2"?: string | null,"bill_to_type"?: string | null,"billing_name": string,"city": string,"contact_person"?: string | null,"created_at"?: string,"deal_id": string,"email"?: string | null,"gst_reason"?: string | null,"gst_status"?: string | null,"gstin"?: string | null,"legal_entity_id": string,"party_copied_at"?: string | null,"party_id"?: string | null,"phone"?: string | null,"postal_code": string,"prefill_source"?: string,"row_version"?: number,"state_code": string,"status"?: string,"updated_at"?: string,"updated_by": string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "address_line1"?: string,"address_line2"?: string | null,"bill_to_type"?: string | null,"billing_name"?: string,"city"?: string,"contact_person"?: string | null,"created_at"?: string,"deal_id"?: string,"email"?: string | null,"gst_reason"?: string | null,"gst_status"?: string | null,"gstin"?: string | null,"legal_entity_id"?: string,"party_copied_at"?: string | null,"party_id"?: string | null,"phone"?: string | null,"postal_code"?: string,"prefill_source"?: string,"row_version"?: number,"state_code"?: string,"status"?: string,"updated_at"?: string,"updated_by"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_billing_profiles_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_billing_profiles_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "customer_parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_billing_profiles_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_billing_profiles_verified_by_fkey"
      columns: ["verified_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"customer_parties": {
                  Row: {
                    "address_line1": string | null,"address_line2": string | null,"branch_id": string | null,"check_reason": string | null,"check_status": string,"checked_at": string | null,"checked_by": string | null,"city": string | null,"contact_person": string | null,"created_at": string,"created_by": string,"email": string | null,"gst_reason": string | null,"gst_status": string | null,"gstin": string | null,"id": string,"import_batch_id": string | null,"legal_entity_id": string,"name": string,"name_key": string | null,"party_type": string,"phone": string | null,"phone_digits": string | null,"postal_code": string | null,"row_version": number,"source_ref": string | null,"state_code": string | null,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "address_line1"?: string | null,"address_line2"?: string | null,"branch_id"?: string | null,"check_reason"?: string | null,"check_status"?: string,"checked_at"?: string | null,"checked_by"?: string | null,"city"?: string | null,"contact_person"?: string | null,"created_at"?: string,"created_by": string,"email"?: string | null,"gst_reason"?: string | null,"gst_status"?: string | null,"gstin"?: string | null,"id"?: string,"import_batch_id"?: string | null,"legal_entity_id": string,"name": string,"name_key"?: never,"party_type": string,"phone"?: string | null,"phone_digits"?: never,"postal_code"?: string | null,"row_version"?: number,"source_ref"?: string | null,"state_code"?: string | null,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "address_line1"?: string | null,"address_line2"?: string | null,"branch_id"?: string | null,"check_reason"?: string | null,"check_status"?: string,"checked_at"?: string | null,"checked_by"?: string | null,"city"?: string | null,"contact_person"?: string | null,"created_at"?: string,"created_by"?: string,"email"?: string | null,"gst_reason"?: string | null,"gst_status"?: string | null,"gstin"?: string | null,"id"?: string,"import_batch_id"?: string | null,"legal_entity_id"?: string,"name"?: string,"name_key"?: never,"party_type"?: string,"phone"?: string | null,"phone_digits"?: never,"postal_code"?: string | null,"row_version"?: number,"source_ref"?: string | null,"state_code"?: string | null,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_parties_branch_id_fkey"
      columns: ["branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_parties_checked_by_fkey"
      columns: ["checked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_parties_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_parties_import_batch_fkey"
      columns: ["import_batch_id"]
isOneToOne: false
      referencedRelation: "import_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_parties_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_parties_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"customer_party_documents": {
                  Row: {
                    "consent_at": string | null,"consent_by": string | null,"created_at": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"party_id": string,"removed_at": string | null,"removed_by": string | null,"request_id": string,"row_version": number,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "consent_at"?: string | null,"consent_by"?: string | null,"created_at"?: string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"party_id": string,"removed_at"?: string | null,"removed_by"?: string | null,"request_id": string,"row_version"?: number,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "consent_at"?: string | null,"consent_by"?: string | null,"created_at"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"party_id"?: string,"removed_at"?: string | null,"removed_by"?: string | null,"request_id"?: string,"row_version"?: number,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_party_documents_consent_by_fkey"
      columns: ["consent_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_party_documents_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_party_documents_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "customer_parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_party_documents_removed_by_fkey"
      columns: ["removed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_party_documents_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"customer_payment_claims": {
                  Row: {
                    "amount_paise": number,"booking_version_id": string,"cheque_date": string | null,"cheque_number": string | null,"closed_at": string | null,"closed_by": string | null,"closed_reason": string | null,"currency": string,"deal_id": string,"destination_version_id": string | null,"id": string,"legal_entity_id": string,"link_kind": string | null,"link_reason": string | null,"linked_at": string | null,"linked_by": string | null,"linked_receipt_id": string | null,"mode": string,"note": string | null,"paid_on": string,"payer_name": string,"reference": string | null,"reference_norm": string | null,"reported_at": string,"reported_by": string,"request_id": string,"row_version": number,"status": string,"updated_at": string
                  }
                  Insert: {
                    "amount_paise": number,"booking_version_id": string,"cheque_date"?: string | null,"cheque_number"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"closed_reason"?: string | null,"currency"?: string,"deal_id": string,"destination_version_id"?: string | null,"id"?: string,"legal_entity_id": string,"link_kind"?: string | null,"link_reason"?: string | null,"linked_at"?: string | null,"linked_by"?: string | null,"linked_receipt_id"?: string | null,"mode": string,"note"?: string | null,"paid_on": string,"payer_name": string,"reference"?: string | null,"reference_norm"?: string | null,"reported_at"?: string,"reported_by": string,"request_id": string,"row_version"?: number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "amount_paise"?: number,"booking_version_id"?: string,"cheque_date"?: string | null,"cheque_number"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"closed_reason"?: string | null,"currency"?: string,"deal_id"?: string,"destination_version_id"?: string | null,"id"?: string,"legal_entity_id"?: string,"link_kind"?: string | null,"link_reason"?: string | null,"linked_at"?: string | null,"linked_by"?: string | null,"linked_receipt_id"?: string | null,"mode"?: string,"note"?: string | null,"paid_on"?: string,"payer_name"?: string,"reference"?: string | null,"reference_norm"?: string | null,"reported_at"?: string,"reported_by"?: string,"request_id"?: string,"row_version"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_payment_claims_closed_by_fkey"
      columns: ["closed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_payment_claims_legal_entity_id_deal_id_booking_ve_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "customer_payment_claims_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_payment_claims_legal_entity_id_destination_versio_fkey"
      columns: ["legal_entity_id","destination_version_id"]
isOneToOne: false
      referencedRelation: "company_destination_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_payment_claims_legal_entity_id_linked_receipt_id_fkey"
      columns: ["legal_entity_id","linked_receipt_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_payment_claims_linked_by_fkey"
      columns: ["linked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_payment_claims_reported_by_fkey"
      columns: ["reported_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"customer_receipts": {
                  Row: {
                    "account_payee": boolean | null,"amount_paise": number,"booking_version_id": string | null,"branch_id": string,"cheque_date": string | null,"cheque_number": string | null,"cleared_at": string | null,"cleared_by": string | null,"collector_user_id": string | null,"corrected_by_receipt_id": string | null,"corrects_receipt_id": string | null,"currency": string,"deal_id": string,"destination_snapshot": Json | null,"destination_version_id": string | null,"evidence_watermark": number,"fiscal_year": string,"id": string,"legal_entity_id": string,"marked_at": string | null,"marked_by": string | null,"micr_code": string | null,"mode": string,"note": string | null,"outcome_date": string | null,"payer_mobile": string | null,"payer_name": string,"payer_pan": string | null,"policy_version_id": string,"reason": string | null,"receipt_no": string,"received_on": string,"recorded_at": string,"recorded_by": string,"reference": string | null,"reference_norm": string | null,"rejected_at": string | null,"rejected_by": string | null,"rejection_kind": string | null,"represent_count": number,"request_id": string,"reversal_kind": string | null,"reversed_at": string | null,"reversed_by": string | null,"row_version": number,"status": string,"updated_at": string,"verified_at": string | null,"verified_by": string | null
                  }
                  Insert: {
                    "account_payee"?: boolean | null,"amount_paise": number,"booking_version_id"?: string | null,"branch_id": string,"cheque_date"?: string | null,"cheque_number"?: string | null,"cleared_at"?: string | null,"cleared_by"?: string | null,"collector_user_id"?: string | null,"corrected_by_receipt_id"?: string | null,"corrects_receipt_id"?: string | null,"currency"?: string,"deal_id": string,"destination_snapshot"?: Json | null,"destination_version_id"?: string | null,"evidence_watermark"?: number,"fiscal_year": string,"id"?: string,"legal_entity_id": string,"marked_at"?: string | null,"marked_by"?: string | null,"micr_code"?: string | null,"mode": string,"note"?: string | null,"outcome_date"?: string | null,"payer_mobile"?: string | null,"payer_name": string,"payer_pan"?: string | null,"policy_version_id": string,"reason"?: string | null,"receipt_no": string,"received_on": string,"recorded_at"?: string,"recorded_by": string,"reference"?: string | null,"reference_norm"?: string | null,"rejected_at"?: string | null,"rejected_by"?: string | null,"rejection_kind"?: string | null,"represent_count"?: number,"request_id": string,"reversal_kind"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"row_version"?: number,"status"?: string,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "account_payee"?: boolean | null,"amount_paise"?: number,"booking_version_id"?: string | null,"branch_id"?: string,"cheque_date"?: string | null,"cheque_number"?: string | null,"cleared_at"?: string | null,"cleared_by"?: string | null,"collector_user_id"?: string | null,"corrected_by_receipt_id"?: string | null,"corrects_receipt_id"?: string | null,"currency"?: string,"deal_id"?: string,"destination_snapshot"?: Json | null,"destination_version_id"?: string | null,"evidence_watermark"?: number,"fiscal_year"?: string,"id"?: string,"legal_entity_id"?: string,"marked_at"?: string | null,"marked_by"?: string | null,"micr_code"?: string | null,"mode"?: string,"note"?: string | null,"outcome_date"?: string | null,"payer_mobile"?: string | null,"payer_name"?: string,"payer_pan"?: string | null,"policy_version_id"?: string,"reason"?: string | null,"receipt_no"?: string,"received_on"?: string,"recorded_at"?: string,"recorded_by"?: string,"reference"?: string | null,"reference_norm"?: string | null,"rejected_at"?: string | null,"rejected_by"?: string | null,"rejection_kind"?: string | null,"represent_count"?: number,"request_id"?: string,"reversal_kind"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"row_version"?: number,"status"?: string,"updated_at"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_receipts_booking_version_id_fkey"
      columns: ["booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_receipts_cleared_by_fkey"
      columns: ["cleared_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_collector_user_id_fkey"
      columns: ["collector_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_corrected_by_receipt_id_fkey"
      columns: ["corrected_by_receipt_id"]
isOneToOne: true
      referencedRelation: "customer_receipts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_receipts_corrects_receipt_id_fkey"
      columns: ["corrects_receipt_id"]
isOneToOne: true
      referencedRelation: "customer_receipts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_receipts_destination_fk"
      columns: ["legal_entity_id","destination_version_id"]
isOneToOne: false
      referencedRelation: "company_destination_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_receipts_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_receipts_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "customer_receipts_marked_by_fkey"
      columns: ["marked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_policy_version_id_fkey"
      columns: ["policy_version_id"]
isOneToOne: false
      referencedRelation: "finance_policy_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "customer_receipts_recorded_by_fkey"
      columns: ["recorded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_rejected_by_fkey"
      columns: ["rejected_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_reversed_by_fkey"
      columns: ["reversed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "customer_receipts_verified_by_fkey"
      columns: ["verified_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"deal_assignments": {
                  Row: {
                    "assigned_by": string | null,"assignment_kind": string,"created_at": string,"deal_id": string,"ended_at": string | null,"id": string,"legal_entity_id": string,"user_id": string
                  }
                  Insert: {
                    "assigned_by"?: string | null,"assignment_kind": string,"created_at"?: string,"deal_id": string,"ended_at"?: string | null,"id"?: string,"legal_entity_id": string,"user_id": string
                  }
                  Update: {
                    "assigned_by"?: string | null,"assignment_kind"?: string,"created_at"?: string,"deal_id"?: string,"ended_at"?: string | null,"id"?: string,"legal_entity_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_assignments_assigned_by_fkey"
      columns: ["assigned_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "deal_assignments_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "deal_assignments_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"deal_commercials": {
                  Row: {
                    "currency": string,"deal_id": string,"estimated_margin_paise": number,"is_synthetic": boolean,"legal_entity_id": string,"selling_total_paise": number
                  }
                  Insert: {
                    "currency"?: string,"deal_id": string,"estimated_margin_paise": number,"is_synthetic"?: boolean,"legal_entity_id": string,"selling_total_paise": number
                  }
                  Update: {
                    "currency"?: string,"deal_id"?: string,"estimated_margin_paise"?: number,"is_synthetic"?: boolean,"legal_entity_id"?: string,"selling_total_paise"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_commercials_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "deal_commercials_synthetic_parent"
      columns: ["legal_entity_id","deal_id","is_synthetic"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id","is_synthetic"]
    }
                  ]
                },"deal_list_changes": {
                  Row: {
                    "changed_at": string,"legal_entity_id": string,"removed": number,"restored": number
                  }
                  Insert: {
                    "changed_at"?: string,"legal_entity_id": string,"removed"?: number,"restored"?: number
                  }
                  Update: {
                    "changed_at"?: string,"legal_entity_id"?: string,"removed"?: number,"restored"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_list_changes_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"deal_removal_participants": {
                  Row: {
                    "deal_id": string,"id": string,"legal_entity_id": string,"participation": string,"removed_at": string,"removed_reason": string,"user_id": string
                  }
                  Insert: {
                    "deal_id": string,"id"?: string,"legal_entity_id": string,"participation": string,"removed_at": string,"removed_reason": string,"user_id": string
                  }
                  Update: {
                    "deal_id"?: string,"id"?: string,"legal_entity_id"?: string,"participation"?: string,"removed_at"?: string,"removed_reason"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_removal_participants_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "deal_removal_participants_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"deal_source_trip_facts": {
                  Row: {
                    "adults": number | null,"booking_notes": string | null,"children": number | null,"created_at": string,"customer_type_enum_id": string | null,"deal_id": string,"destination_field": string | null,"destination_option_id": string | null,"details_issues": (string)[],"details_read_at": string | null,"infants": number | null,"legal_entity_id": string,"read_at": string,"read_issues": (string)[],"source_company_id": number | null,"source_contact_id": number | null,"source_contact_ids": (number)[],"source_modified_at": string,"tour_end": string | null,"tour_start": string | null,"traveller_total": number | null
                  }
                  Insert: {
                    "adults"?: number | null,"booking_notes"?: string | null,"children"?: number | null,"created_at"?: string,"customer_type_enum_id"?: string | null,"deal_id": string,"destination_field"?: string | null,"destination_option_id"?: string | null,"details_issues"?: (string)[],"details_read_at"?: string | null,"infants"?: number | null,"legal_entity_id": string,"read_at"?: string,"read_issues"?: (string)[],"source_company_id"?: number | null,"source_contact_id"?: number | null,"source_contact_ids"?: (number)[],"source_modified_at": string,"tour_end"?: string | null,"tour_start"?: string | null,"traveller_total"?: number | null
                  }
                  Update: {
                    "adults"?: number | null,"booking_notes"?: string | null,"children"?: number | null,"created_at"?: string,"customer_type_enum_id"?: string | null,"deal_id"?: string,"destination_field"?: string | null,"destination_option_id"?: string | null,"details_issues"?: (string)[],"details_read_at"?: string | null,"infants"?: number | null,"legal_entity_id"?: string,"read_at"?: string,"read_issues"?: (string)[],"source_company_id"?: number | null,"source_contact_id"?: number | null,"source_contact_ids"?: (number)[],"source_modified_at"?: string,"tour_end"?: string | null,"tour_start"?: string | null,"traveller_total"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_source_trip_facts_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: true
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deal_source_trip_facts_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"deal_travellers": {
                  Row: {
                    "age_years": number | null,"created_at": string,"deal_id": string,"full_name": string,"id": string,"legal_entity_id": string,"seq": number,"special_needs": string | null,"special_requests": (string)[],"traveller_type": string,"updated_at": string
                  }
                  Insert: {
                    "age_years"?: number | null,"created_at"?: string,"deal_id": string,"full_name": string,"id"?: string,"legal_entity_id": string,"seq": number,"special_needs"?: string | null,"special_requests"?: (string)[],"traveller_type": string,"updated_at"?: string
                  }
                  Update: {
                    "age_years"?: number | null,"created_at"?: string,"deal_id"?: string,"full_name"?: string,"id"?: string,"legal_entity_id"?: string,"seq"?: number,"special_needs"?: string | null,"special_requests"?: (string)[],"traveller_type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_travellers_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"deals": {
                  Row: {
                    "branch_id": string,"created_at": string,"id": string,"intake_inbox_id": string | null,"is_synthetic": boolean,"last_synced_at": string | null,"last_verified_at": string | null,"legal_entity_id": string,"owner_user_id": string | null,"reference": string,"removed_at": string | null,"removed_reason": string | null,"source_assigned_by_id": number | null,"source_category_id": number | null,"source_created_at": string | null,"source_deal_id": number | null,"source_lead_id": number | null,"source_modified_at": string | null,"source_portal": string | null,"source_stage_id": string | null,"source_system": string | null,"title": string
                  }
                  Insert: {
                    "branch_id": string,"created_at"?: string,"id"?: string,"intake_inbox_id"?: string | null,"is_synthetic"?: boolean,"last_synced_at"?: string | null,"last_verified_at"?: string | null,"legal_entity_id": string,"owner_user_id"?: string | null,"reference": string,"removed_at"?: string | null,"removed_reason"?: string | null,"source_assigned_by_id"?: number | null,"source_category_id"?: number | null,"source_created_at"?: string | null,"source_deal_id"?: number | null,"source_lead_id"?: number | null,"source_modified_at"?: string | null,"source_portal"?: string | null,"source_stage_id"?: string | null,"source_system"?: string | null,"title": string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"id"?: string,"intake_inbox_id"?: string | null,"is_synthetic"?: boolean,"last_synced_at"?: string | null,"last_verified_at"?: string | null,"legal_entity_id"?: string,"owner_user_id"?: string | null,"reference"?: string,"removed_at"?: string | null,"removed_reason"?: string | null,"source_assigned_by_id"?: number | null,"source_category_id"?: number | null,"source_created_at"?: string | null,"source_deal_id"?: number | null,"source_lead_id"?: number | null,"source_modified_at"?: string | null,"source_portal"?: string | null,"source_stage_id"?: string | null,"source_system"?: string | null,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deals_intake_inbox_id_fkey"
      columns: ["intake_inbox_id"]
isOneToOne: false
      referencedRelation: "integration_inbox"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "deals_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"department_cost_entries": {
                  Row: {
                    "amount_paise": number,"branch_id": string,"cost_kind": string,"created_at": string,"created_by": string,"currency": string,"deal_id": string,"department": string,"expense_status": string | null,"id": string,"legal_entity_id": string,"paid_by": string,"paid_on": string | null,"payment_mode": string | null,"receipt_evidence_id": string | null,"reference": string | null,"request_id": string,"return_reason": string | null,"reviewed_at": string | null,"reviewed_by": string | null,"row_version": number,"submitted_at": string | null,"submitted_by": string | null,"task_id": string,"updated_at": string
                  }
                  Insert: {
                    "amount_paise": number,"branch_id": string,"cost_kind": string,"created_at"?: string,"created_by": string,"currency"?: string,"deal_id": string,"department": string,"expense_status"?: string | null,"id"?: string,"legal_entity_id": string,"paid_by": string,"paid_on"?: string | null,"payment_mode"?: string | null,"receipt_evidence_id"?: string | null,"reference"?: string | null,"request_id": string,"return_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"row_version"?: number,"submitted_at"?: string | null,"submitted_by"?: string | null,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount_paise"?: number,"branch_id"?: string,"cost_kind"?: string,"created_at"?: string,"created_by"?: string,"currency"?: string,"deal_id"?: string,"department"?: string,"expense_status"?: string | null,"id"?: string,"legal_entity_id"?: string,"paid_by"?: string,"paid_on"?: string | null,"payment_mode"?: string | null,"receipt_evidence_id"?: string | null,"reference"?: string | null,"request_id"?: string,"return_reason"?: string | null,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"row_version"?: number,"submitted_at"?: string | null,"submitted_by"?: string | null,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "department_cost_entries_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "department_cost_entries_legal_entity_id_branch_id_deal_id_fkey"
      columns: ["legal_entity_id","branch_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","branch_id","id"]
    },{
      foreignKeyName: "department_cost_entries_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "department_cost_entries_receipt_evidence_id_fkey"
      columns: ["receipt_evidence_id"]
isOneToOne: false
      referencedRelation: "department_evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "department_cost_entries_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "department_cost_entries_submitted_by_fkey"
      columns: ["submitted_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"department_evidence": {
                  Row: {
                    "application_id": string | null,"created_at": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"task_id": string,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "application_id"?: string | null,"created_at"?: string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"task_id": string,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "application_id"?: string | null,"created_at"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"task_id"?: string,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "department_evidence_application_fk"
      columns: ["application_id"]
isOneToOne: false
      referencedRelation: "visa_applications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "department_evidence_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "department_evidence_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"deployment_settings": {
                  Row: {
                    "environment": string,"id": boolean,"updated_at": string
                  }
                  Insert: {
                    "environment"?: string,"id"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "environment"?: string,"id"?: boolean,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"finance_command_results": {
                  Row: {
                    "actor": string,"command": string,"created_at": string,"legal_entity_id": string,"payload_hash": string,"request_id": string,"result": NonNullable<Json>
                  }
                  Insert: {
                    "actor": string,"command": string,"created_at"?: string,"legal_entity_id": string,"payload_hash": string,"request_id": string,"result": NonNullable<Json>
                  }
                  Update: {
                    "actor"?: string,"command"?: string,"created_at"?: string,"legal_entity_id"?: string,"payload_hash"?: string,"request_id"?: string,"result"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_command_results_actor_fkey"
      columns: ["actor"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "finance_command_results_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_deal_heads": {
                  Row: {
                    "created_at": string,"deal_id": string,"legal_entity_id": string
                  }
                  Insert: {
                    "created_at"?: string,"deal_id": string,"legal_entity_id": string
                  }
                  Update: {
                    "created_at"?: string,"deal_id"?: string,"legal_entity_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_deal_heads_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"finance_evidence": {
                  Row: {
                    "branch_id": string | null,"created_at": string,"deposit_id": string | null,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"receipt_id": string | null,"released": boolean,"request_id": string | null,"seq": number,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "branch_id"?: string | null,"created_at"?: string,"deposit_id"?: string | null,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"receipt_id"?: string | null,"released"?: boolean,"request_id"?: string | null,"seq"?: never,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "branch_id"?: string | null,"created_at"?: string,"deposit_id"?: string | null,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"receipt_id"?: string | null,"released"?: boolean,"request_id"?: string | null,"seq"?: never,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_evidence_deposit_id_fkey"
      columns: ["deposit_id"]
isOneToOne: false
      referencedRelation: "cash_deposits"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_evidence_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "finance_evidence_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_evidence_receipt_id_fkey"
      columns: ["receipt_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_evidence_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"finance_journal_entries": {
                  Row: {
                    "branch_id": string,"business_date": string,"deal_id": string | null,"deposit_id": string | null,"id": string,"kind": string,"legal_entity_id": string,"posted_at": string,"posted_by": string,"receipt_id": string | null,"reverses_entry_id": string | null
                  }
                  Insert: {
                    "branch_id": string,"business_date": string,"deal_id"?: string | null,"deposit_id"?: string | null,"id"?: string,"kind": string,"legal_entity_id": string,"posted_at"?: string,"posted_by": string,"receipt_id"?: string | null,"reverses_entry_id"?: string | null
                  }
                  Update: {
                    "branch_id"?: string,"business_date"?: string,"deal_id"?: string | null,"deposit_id"?: string | null,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"posted_at"?: string,"posted_by"?: string,"receipt_id"?: string | null,"reverses_entry_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_journal_entries_branch_id_fkey"
      columns: ["branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_entries_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_entries_deposit_id_fkey"
      columns: ["deposit_id"]
isOneToOne: false
      referencedRelation: "cash_deposits"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_entries_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_entries_posted_by_fkey"
      columns: ["posted_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "finance_journal_entries_receipt_id_fkey"
      columns: ["receipt_id"]
isOneToOne: false
      referencedRelation: "customer_receipts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_entries_reverses_entry_id_fkey"
      columns: ["reverses_entry_id"]
isOneToOne: true
      referencedRelation: "finance_journal_entries"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_journal_lines": {
                  Row: {
                    "account": string,"branch_id": string,"credit_paise": number,"deal_id": string | null,"debit_paise": number,"entry_id": string,"id": number
                  }
                  Insert: {
                    "account": string,"branch_id": string,"credit_paise"?: number,"deal_id"?: string | null,"debit_paise"?: number,"entry_id": string,"id"?: never
                  }
                  Update: {
                    "account"?: string,"branch_id"?: string,"credit_paise"?: number,"deal_id"?: string | null,"debit_paise"?: number,"entry_id"?: string,"id"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_journal_lines_branch_id_fkey"
      columns: ["branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_lines_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "finance_journal_lines_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "finance_journal_entries"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_legal_limits": {
                  Row: {
                    "cash_cap_ceiling_paise": number,"legal_entity_id": string,"receipt_max_ceiling_paise": number,"updated_at": string
                  }
                  Insert: {
                    "cash_cap_ceiling_paise"?: number,"legal_entity_id": string,"receipt_max_ceiling_paise"?: number,"updated_at"?: string
                  }
                  Update: {
                    "cash_cap_ceiling_paise"?: number,"legal_entity_id"?: string,"receipt_max_ceiling_paise"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_legal_limits_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_live_settings": {
                  Row: {
                    "bank_transfer_live": boolean,"cash_live": boolean,"cheque_live": boolean,"legal_entity_id": string,"updated_at": string,"upi_live": boolean
                  }
                  Insert: {
                    "bank_transfer_live"?: boolean,"cash_live"?: boolean,"cheque_live"?: boolean,"legal_entity_id": string,"updated_at"?: string,"upi_live"?: boolean
                  }
                  Update: {
                    "bank_transfer_live"?: boolean,"cash_live"?: boolean,"cheque_live"?: boolean,"legal_entity_id"?: string,"updated_at"?: string,"upi_live"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_live_settings_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_policy_heads": {
                  Row: {
                    "current_version_no": number,"legal_entity_id": string,"updated_at": string
                  }
                  Insert: {
                    "current_version_no": number,"legal_entity_id": string,"updated_at"?: string
                  }
                  Update: {
                    "current_version_no"?: number,"legal_entity_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_policy_heads_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"finance_policy_versions": {
                  Row: {
                    "cash_deposit_days": number,"cash_payer_day_cap_paise": number,"cash_trip_cap_paise": number,"created_at": string,"created_by": string | null,"effective_at": string,"id": string,"legal_entity_id": string,"reason": string,"receipt_max_paise": number,"reconciliation_required": boolean,"request_id": string | null,"version_no": number
                  }
                  Insert: {
                    "cash_deposit_days": number,"cash_payer_day_cap_paise": number,"cash_trip_cap_paise": number,"created_at"?: string,"created_by"?: string | null,"effective_at": string,"id"?: string,"legal_entity_id": string,"reason": string,"receipt_max_paise": number,"reconciliation_required": boolean,"request_id"?: string | null,"version_no": number
                  }
                  Update: {
                    "cash_deposit_days"?: number,"cash_payer_day_cap_paise"?: number,"cash_trip_cap_paise"?: number,"created_at"?: string,"created_by"?: string | null,"effective_at"?: string,"id"?: string,"legal_entity_id"?: string,"reason"?: string,"receipt_max_paise"?: number,"reconciliation_required"?: boolean,"request_id"?: string | null,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_policy_versions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "finance_policy_versions_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "finance_policy_heads"
      referencedColumns: ["legal_entity_id"]
    }
                  ]
                },"finance_receipt_counters": {
                  Row: {
                    "fiscal_year": string,"last_no": number,"legal_entity_id": string
                  }
                  Insert: {
                    "fiscal_year": string,"last_no"?: number,"legal_entity_id": string
                  }
                  Update: {
                    "fiscal_year"?: string,"last_no"?: number,"legal_entity_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "finance_receipt_counters_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"fulfilment_tasks": {
                  Row: {
                    "assignee_user_id": string | null,"booking_version_id": string,"branch_id": string,"completed_at": string | null,"completed_by": string | null,"created_at": string,"created_by": string,"deal_id": string,"department": string,"id": string,"legal_entity_id": string,"selected_quote_id": string | null,"service_item_id": string,"service_purpose": string,"status": string,"supplier_confirmed_at": string | null,"supplier_confirmed_by": string | null,"supplier_reference": string | null,"task_key": string,"updated_at": string
                  }
                  Insert: {
                    "assignee_user_id"?: string | null,"booking_version_id": string,"branch_id": string,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by": string,"deal_id": string,"department"?: string,"id"?: string,"legal_entity_id": string,"selected_quote_id"?: string | null,"service_item_id": string,"service_purpose"?: string,"status"?: string,"supplier_confirmed_at"?: string | null,"supplier_confirmed_by"?: string | null,"supplier_reference"?: string | null,"task_key": string,"updated_at"?: string
                  }
                  Update: {
                    "assignee_user_id"?: string | null,"booking_version_id"?: string,"branch_id"?: string,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by"?: string,"deal_id"?: string,"department"?: string,"id"?: string,"legal_entity_id"?: string,"selected_quote_id"?: string | null,"service_item_id"?: string,"service_purpose"?: string,"status"?: string,"supplier_confirmed_at"?: string | null,"supplier_confirmed_by"?: string | null,"supplier_reference"?: string | null,"task_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fulfilment_tasks_assignee_user_id_fkey"
      columns: ["assignee_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "fulfilment_tasks_completed_by_fkey"
      columns: ["completed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "fulfilment_tasks_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "fulfilment_tasks_legal_entity_id_branch_id_deal_id_fkey"
      columns: ["legal_entity_id","branch_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","branch_id","id"]
    },{
      foreignKeyName: "fulfilment_tasks_legal_entity_id_deal_id_booking_version_i_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "fulfilment_tasks_selected_quote_fk"
      columns: ["id","selected_quote_id"]
isOneToOne: false
      referencedRelation: "purchase_quotes"
      referencedColumns: ["task_id","id"]
    },{
      foreignKeyName: "fulfilment_tasks_service_item_fk"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "fulfilment_tasks_supplier_confirmed_by_fkey"
      columns: ["supplier_confirmed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"hotel_catalogue": {
                  Row: {
                    "address": string | null,"area": string | null,"checked_at": string | null,"checked_by": string | null,"city": string,"created_at": string,"created_by": string,"id": string,"import_batch_id": string | null,"legal_entity_id": string,"name": string,"name_key": string | null,"row_version": number,"source_ref": string | null,"star_category": string | null,"status": string,"updated_at": string,"updated_by": string,"verification": string
                  }
                  Insert: {
                    "address"?: string | null,"area"?: string | null,"checked_at"?: string | null,"checked_by"?: string | null,"city": string,"created_at"?: string,"created_by": string,"id"?: string,"import_batch_id"?: string | null,"legal_entity_id": string,"name": string,"name_key"?: never,"row_version"?: number,"source_ref"?: string | null,"star_category"?: string | null,"status"?: string,"updated_at"?: string,"updated_by": string,"verification"?: string
                  }
                  Update: {
                    "address"?: string | null,"area"?: string | null,"checked_at"?: string | null,"checked_by"?: string | null,"city"?: string,"created_at"?: string,"created_by"?: string,"id"?: string,"import_batch_id"?: string | null,"legal_entity_id"?: string,"name"?: string,"name_key"?: never,"row_version"?: number,"source_ref"?: string | null,"star_category"?: string | null,"status"?: string,"updated_at"?: string,"updated_by"?: string,"verification"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "hotel_catalogue_checked_by_fkey"
      columns: ["checked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "hotel_catalogue_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "hotel_catalogue_import_batch_fkey"
      columns: ["import_batch_id"]
isOneToOne: false
      referencedRelation: "import_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "hotel_catalogue_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "hotel_catalogue_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"import_batches": {
                  Row: {
                    "applied_at": string | null,"applied_by": string | null,"apply_reason": string | null,"apply_result": Json | null,"branch_id": string | null,"created_at": string,"entity_wide": boolean,"id": string,"kind": string,"legal_entity_id": string,"request_id": string,"row_count": number,"row_version": number,"source_file_name": string,"source_sha256": string,"status": string,"summary": Json | null,"updated_at": string,"uploaded_by": string,"validated_at": string | null,"validated_by": string | null
                  }
                  Insert: {
                    "applied_at"?: string | null,"applied_by"?: string | null,"apply_reason"?: string | null,"apply_result"?: Json | null,"branch_id"?: string | null,"created_at"?: string,"entity_wide"?: boolean,"id"?: string,"kind": string,"legal_entity_id": string,"request_id": string,"row_count": number,"row_version"?: number,"source_file_name": string,"source_sha256": string,"status"?: string,"summary"?: Json | null,"updated_at"?: string,"uploaded_by": string,"validated_at"?: string | null,"validated_by"?: string | null
                  }
                  Update: {
                    "applied_at"?: string | null,"applied_by"?: string | null,"apply_reason"?: string | null,"apply_result"?: Json | null,"branch_id"?: string | null,"created_at"?: string,"entity_wide"?: boolean,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"request_id"?: string,"row_count"?: number,"row_version"?: number,"source_file_name"?: string,"source_sha256"?: string,"status"?: string,"summary"?: Json | null,"updated_at"?: string,"uploaded_by"?: string,"validated_at"?: string | null,"validated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_batches_applied_by_fkey"
      columns: ["applied_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "import_batches_branch_id_fkey"
      columns: ["branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_batches_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_batches_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "import_batches_validated_by_fkey"
      columns: ["validated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"import_rows": {
                  Row: {
                    "batch_id": string,"before": Json | null,"data": NonNullable<Json>,"legal_entity_id": string,"outcome": string | null,"reasons": (string)[],"row_no": number,"source_ref": string | null,"target_id": string | null,"warnings": (string)[]
                  }
                  Insert: {
                    "batch_id": string,"before"?: Json | null,"data": NonNullable<Json>,"legal_entity_id": string,"outcome"?: string | null,"reasons"?: (string)[],"row_no": number,"source_ref"?: string | null,"target_id"?: string | null,"warnings"?: (string)[]
                  }
                  Update: {
                    "batch_id"?: string,"before"?: Json | null,"data"?: NonNullable<Json>,"legal_entity_id"?: string,"outcome"?: string | null,"reasons"?: (string)[],"row_no"?: number,"source_ref"?: string | null,"target_id"?: string | null,"warnings"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_rows_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "import_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_rows_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"intake_manifest_items": {
                  Row: {
                    "manifest_id": string,"source_id": number,"source_object": string
                  }
                  Insert: {
                    "manifest_id": string,"source_id": number,"source_object": string
                  }
                  Update: {
                    "manifest_id"?: string,"source_id"?: number,"source_object"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_manifest_items_manifest_id_source_object_fkey"
      columns: ["manifest_id","source_object"]
isOneToOne: false
      referencedRelation: "intake_manifests"
      referencedColumns: ["id","source_object"]
    }
                  ]
                },"intake_manifests": {
                  Row: {
                    "business_date": string,"closed_at": string | null,"closed_by_operator": string | null,"config_id": string,"created_at": string,"created_by_operator": string,"expected_count": number,"id": string,"interval_from": string,"interval_to": string,"source_code": string,"source_object": string,"status": string
                  }
                  Insert: {
                    "business_date": string,"closed_at"?: string | null,"closed_by_operator"?: string | null,"config_id": string,"created_at"?: string,"created_by_operator": string,"expected_count": number,"id"?: string,"interval_from": string,"interval_to": string,"source_code": string,"source_object": string,"status"?: string
                  }
                  Update: {
                    "business_date"?: string,"closed_at"?: string | null,"closed_by_operator"?: string | null,"config_id"?: string,"created_at"?: string,"created_by_operator"?: string,"expected_count"?: number,"id"?: string,"interval_from"?: string,"interval_to"?: string,"source_code"?: string,"source_object"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_manifests_config_id_fkey"
      columns: ["config_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_inbox": {
                  Row: {
                    "attempts": number,"dedupe_key": string,"event_type": string,"id": string,"last_error_at": string | null,"last_error_code": string | null,"lock_token": string | null,"locked_until": string | null,"max_attempts": number,"next_attempt_at": string | null,"origin": string,"portal_member_id": string,"processed_at": string | null,"processed_deal_id": string | null,"processed_lead_id": string | null,"reason_code": string | null,"received_at": string,"source_deal_id": number,"source_object": string,"source_system": string,"source_ts": number,"status": string,"updated_at": string
                  }
                  Insert: {
                    "attempts"?: number,"dedupe_key": string,"event_type": string,"id"?: string,"last_error_at"?: string | null,"last_error_code"?: string | null,"lock_token"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"origin"?: string,"portal_member_id": string,"processed_at"?: string | null,"processed_deal_id"?: string | null,"processed_lead_id"?: string | null,"reason_code"?: string | null,"received_at"?: string,"source_deal_id": number,"source_object"?: string,"source_system"?: string,"source_ts": number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"dedupe_key"?: string,"event_type"?: string,"id"?: string,"last_error_at"?: string | null,"last_error_code"?: string | null,"lock_token"?: string | null,"locked_until"?: string | null,"max_attempts"?: number,"next_attempt_at"?: string | null,"origin"?: string,"portal_member_id"?: string,"processed_at"?: string | null,"processed_deal_id"?: string | null,"processed_lead_id"?: string | null,"reason_code"?: string | null,"received_at"?: string,"source_deal_id"?: number,"source_object"?: string,"source_system"?: string,"source_ts"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_inbox_processed_deal_id_fkey"
      columns: ["processed_deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "integration_inbox_processed_lead_id_fkey"
      columns: ["processed_lead_id"]
isOneToOne: false
      referencedRelation: "crm_leads"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_intake_config": {
                  Row: {
                    "bitrix_id_proof_copy": boolean,"bitrix_name_read": boolean,"bitrix_trip_details_read": boolean,"bitrix_trip_facts_read": boolean,"category_id": number,"created_at": string,"created_by": string | null,"cutoff_at": string,"deal_entry_stage_ids": (string)[] | null,"deal_intake_mode": string,"eligible_category_ids": (number)[] | null,"eligible_stage_ids": (string)[],"enabled": boolean,"id": string,"last_reconcile_requested_at": string | null,"last_reconciled_at": string | null,"lead_intake_mode": string,"lead_intake_unowned": boolean,"lead_reconciled_at": string | null,"pilot_branch_id": string,"pilot_legal_entity_id": string,"portal_domain": string,"portal_member_id": string,"source_system": string,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "bitrix_id_proof_copy"?: boolean,"bitrix_name_read"?: boolean,"bitrix_trip_details_read"?: boolean,"bitrix_trip_facts_read"?: boolean,"category_id": number,"created_at"?: string,"created_by"?: string | null,"cutoff_at": string,"deal_entry_stage_ids"?: (string)[] | null,"deal_intake_mode"?: string,"eligible_category_ids"?: (number)[] | null,"eligible_stage_ids": (string)[],"enabled"?: boolean,"id"?: string,"last_reconcile_requested_at"?: string | null,"last_reconciled_at"?: string | null,"lead_intake_mode"?: string,"lead_intake_unowned"?: boolean,"lead_reconciled_at"?: string | null,"pilot_branch_id": string,"pilot_legal_entity_id": string,"portal_domain": string,"portal_member_id": string,"source_system"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "bitrix_id_proof_copy"?: boolean,"bitrix_name_read"?: boolean,"bitrix_trip_details_read"?: boolean,"bitrix_trip_facts_read"?: boolean,"category_id"?: number,"created_at"?: string,"created_by"?: string | null,"cutoff_at"?: string,"deal_entry_stage_ids"?: (string)[] | null,"deal_intake_mode"?: string,"eligible_category_ids"?: (number)[] | null,"eligible_stage_ids"?: (string)[],"enabled"?: boolean,"id"?: string,"last_reconcile_requested_at"?: string | null,"last_reconciled_at"?: string | null,"lead_intake_mode"?: string,"lead_intake_unowned"?: boolean,"lead_reconciled_at"?: string | null,"pilot_branch_id"?: string,"pilot_legal_entity_id"?: string,"portal_domain"?: string,"portal_member_id"?: string,"source_system"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_intake_config_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "integration_intake_config_pilot_legal_entity_id_pilot_bran_fkey"
      columns: ["pilot_legal_entity_id","pilot_branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "integration_intake_config_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"integration_receiver_credentials": {
                  Row: {
                    "active": boolean,"created_at": string,"credential_sha256": string,"id": string,"note": string | null,"revoked_at": string | null,"slot": number
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"credential_sha256": string,"id"?: string,"note"?: string | null,"revoked_at"?: string | null,"slot": number
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"credential_sha256"?: string,"id"?: string,"note"?: string | null,"revoked_at"?: string | null,"slot"?: number
                  }
                  Relationships: [

                  ]
                },"integration_resync_jobs": {
                  Row: {
                    "bitrix_total": number | null,"category_ids": (number)[],"created_at": string,"created_by": string | null,"cursor_id": number,"cutoff_at": string,"enqueued": number,"finished_at": string | null,"id": string,"listing_done": boolean,"lock_token": string | null,"locked_until": string | null,"portal_member_id": string,"reason": string,"result": Json | null,"scanned": number,"stage_ids": (string)[],"started_at": string | null,"status": string
                  }
                  Insert: {
                    "bitrix_total"?: number | null,"category_ids": (number)[],"created_at"?: string,"created_by"?: string | null,"cursor_id"?: number,"cutoff_at": string,"enqueued"?: number,"finished_at"?: string | null,"id"?: string,"listing_done"?: boolean,"lock_token"?: string | null,"locked_until"?: string | null,"portal_member_id": string,"reason": string,"result"?: Json | null,"scanned"?: number,"stage_ids": (string)[],"started_at"?: string | null,"status"?: string
                  }
                  Update: {
                    "bitrix_total"?: number | null,"category_ids"?: (number)[],"created_at"?: string,"created_by"?: string | null,"cursor_id"?: number,"cutoff_at"?: string,"enqueued"?: number,"finished_at"?: string | null,"id"?: string,"listing_done"?: boolean,"lock_token"?: string | null,"locked_until"?: string | null,"portal_member_id"?: string,"reason"?: string,"result"?: Json | null,"scanned"?: number,"stage_ids"?: (string)[],"started_at"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_resync_jobs_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "integration_resync_jobs_portal_member_id_fkey"
      columns: ["portal_member_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["portal_member_id"]
    }
                  ]
                },"integration_resync_seen": {
                  Row: {
                    "job_id": string,"source_deal_id": number
                  }
                  Insert: {
                    "job_id": string,"source_deal_id": number
                  }
                  Update: {
                    "job_id"?: string,"source_deal_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_resync_seen_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "integration_resync_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_sync_dispatches": {
                  Row: {
                    "answered_at": string | null,"dispatched_at": string,"ok": boolean | null,"reason": string | null,"request_id": number,"status_code": number | null
                  }
                  Insert: {
                    "answered_at"?: string | null,"dispatched_at"?: string,"ok"?: boolean | null,"reason"?: string | null,"request_id": number,"status_code"?: number | null
                  }
                  Update: {
                    "answered_at"?: string | null,"dispatched_at"?: string,"ok"?: boolean | null,"reason"?: string | null,"request_id"?: number,"status_code"?: number | null
                  }
                  Relationships: [

                  ]
                },"integration_sync_incidents": {
                  Row: {
                    "id": string,"open_notified_at": string | null,"open_sending_until": string | null,"opened_at": string,"portal_member_id": string,"reason_code": string,"recovered_at": string | null,"recovery_notified_at": string | null,"recovery_sending_until": string | null
                  }
                  Insert: {
                    "id"?: string,"open_notified_at"?: string | null,"open_sending_until"?: string | null,"opened_at"?: string,"portal_member_id": string,"reason_code": string,"recovered_at"?: string | null,"recovery_notified_at"?: string | null,"recovery_sending_until"?: string | null
                  }
                  Update: {
                    "id"?: string,"open_notified_at"?: string | null,"open_sending_until"?: string | null,"opened_at"?: string,"portal_member_id"?: string,"reason_code"?: string,"recovered_at"?: string | null,"recovery_notified_at"?: string | null,"recovery_sending_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_sync_incidents_portal_member_id_fkey"
      columns: ["portal_member_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["portal_member_id"]
    }
                  ]
                },"integration_sync_previews": {
                  Row: {
                    "actor_user_id": string,"category_ids": (number)[],"config_id": string,"config_snapshot": NonNullable<Json>,"counts": NonNullable<Json>,"created_at": string,"cutoff_at": string,"deal_intake_mode": string | null,"expires_at": string,"id": string,"lead_intake_mode": string | null,"legal_entity_id": string,"plan_hash": string,"stage_ids": (string)[],"sync_enabled": boolean,"used_at": string | null
                  }
                  Insert: {
                    "actor_user_id": string,"category_ids": (number)[],"config_id": string,"config_snapshot": NonNullable<Json>,"counts": NonNullable<Json>,"created_at"?: string,"cutoff_at": string,"deal_intake_mode"?: string | null,"expires_at": string,"id"?: string,"lead_intake_mode"?: string | null,"legal_entity_id": string,"plan_hash": string,"stage_ids": (string)[],"sync_enabled": boolean,"used_at"?: string | null
                  }
                  Update: {
                    "actor_user_id"?: string,"category_ids"?: (number)[],"config_id"?: string,"config_snapshot"?: NonNullable<Json>,"counts"?: NonNullable<Json>,"created_at"?: string,"cutoff_at"?: string,"deal_intake_mode"?: string | null,"expires_at"?: string,"id"?: string,"lead_intake_mode"?: string | null,"legal_entity_id"?: string,"plan_hash"?: string,"stage_ids"?: (string)[],"sync_enabled"?: boolean,"used_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_sync_previews_config_id_fkey"
      columns: ["config_id"]
isOneToOne: false
      referencedRelation: "integration_intake_config"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "integration_sync_previews_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_sync_schedule": {
                  Row: {
                    "enabled": boolean,"id": boolean,"last_dispatched_at": string | null,"last_request_id": number | null,"updated_at": string
                  }
                  Insert: {
                    "enabled"?: boolean,"id"?: boolean,"last_dispatched_at"?: string | null,"last_request_id"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "enabled"?: boolean,"id"?: boolean,"last_dispatched_at"?: string | null,"last_request_id"?: number | null,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"integration_worker_runs": {
                  Row: {
                    "claimed": number,"created": number,"dead_lettered": number,"enqueued": number,"failed": number,"finished_at": string,"id": string,"ignored": number,"kind": string,"needs_review": number,"outcome": string,"recorded_at": string,"run_trigger": string | null,"started_at": string,"updated": number
                  }
                  Insert: {
                    "claimed"?: number,"created"?: number,"dead_lettered"?: number,"enqueued"?: number,"failed"?: number,"finished_at": string,"id"?: string,"ignored"?: number,"kind": string,"needs_review"?: number,"outcome": string,"recorded_at"?: string,"run_trigger"?: string | null,"started_at": string,"updated"?: number
                  }
                  Update: {
                    "claimed"?: number,"created"?: number,"dead_lettered"?: number,"enqueued"?: number,"failed"?: number,"finished_at"?: string,"id"?: string,"ignored"?: number,"kind"?: string,"needs_review"?: number,"outcome"?: string,"recorded_at"?: string,"run_trigger"?: string | null,"started_at"?: string,"updated"?: number
                  }
                  Relationships: [

                  ]
                },"itinerary_difference_runs": {
                  Row: {
                    "basis_hash": string,"basis_id": string | null,"basis_kind": string,"created_at": string,"created_by": string,"difference_count": number,"draft_id": string,"facts_hash": string,"id": string,"legal_entity_id": string
                  }
                  Insert: {
                    "basis_hash": string,"basis_id"?: string | null,"basis_kind": string,"created_at"?: string,"created_by": string,"difference_count": number,"draft_id": string,"facts_hash": string,"id"?: string,"legal_entity_id": string
                  }
                  Update: {
                    "basis_hash"?: string,"basis_id"?: string | null,"basis_kind"?: string,"created_at"?: string,"created_by"?: string,"difference_count"?: number,"draft_id"?: string,"facts_hash"?: string,"id"?: string,"legal_entity_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_difference_runs_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "itinerary_difference_runs_legal_entity_id_draft_id_fkey"
      columns: ["legal_entity_id","draft_id"]
isOneToOne: false
      referencedRelation: "itinerary_fact_drafts"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"itinerary_documents": {
                  Row: {
                    "branch_id": string,"created_at": string,"created_by": string,"deal_id": string | null,"id": string,"legal_entity_id": string,"quotation_id": string | null,"referral_draft_id": string | null,"request_id": string,"title": string
                  }
                  Insert: {
                    "branch_id": string,"created_at"?: string,"created_by": string,"deal_id"?: string | null,"id"?: string,"legal_entity_id": string,"quotation_id"?: string | null,"referral_draft_id"?: string | null,"request_id": string,"title": string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"created_by"?: string,"deal_id"?: string | null,"id"?: string,"legal_entity_id"?: string,"quotation_id"?: string | null,"referral_draft_id"?: string | null,"request_id"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_documents_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "itinerary_documents_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_documents_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_documents_legal_entity_id_quotation_id_fkey"
      columns: ["legal_entity_id","quotation_id"]
isOneToOne: false
      referencedRelation: "quotations"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_documents_referral_draft_fk"
      columns: ["legal_entity_id","referral_draft_id"]
isOneToOne: false
      referencedRelation: "referral_drafts"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"itinerary_fact_differences": {
                  Row: {
                    "acknowledged_at": string | null,"acknowledged_by": string | null,"basis_value_hash": string | null,"created_at": string,"difference": string,"facts_value_hash": string | null,"field_path": string,"id": string,"legal_entity_id": string,"note": string | null,"run_id": string
                  }
                  Insert: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"basis_value_hash"?: string | null,"created_at"?: string,"difference": string,"facts_value_hash"?: string | null,"field_path": string,"id"?: string,"legal_entity_id": string,"note"?: string | null,"run_id": string
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"basis_value_hash"?: string | null,"created_at"?: string,"difference"?: string,"facts_value_hash"?: string | null,"field_path"?: string,"id"?: string,"legal_entity_id"?: string,"note"?: string | null,"run_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_fact_differences_acknowledged_by_fkey"
      columns: ["acknowledged_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "itinerary_fact_differences_legal_entity_id_run_id_fkey"
      columns: ["legal_entity_id","run_id"]
isOneToOne: false
      referencedRelation: "itinerary_difference_runs"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"itinerary_fact_drafts": {
                  Row: {
                    "created_at": string,"created_by": string,"document_id": string,"facts": NonNullable<Json>,"facts_hash": string,"id": string,"legal_entity_id": string,"ready_run_id": string | null,"row_version": number,"source_file_id": string | null,"status": string,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by": string,"document_id": string,"facts"?: NonNullable<Json>,"facts_hash": string,"id"?: string,"legal_entity_id": string,"ready_run_id"?: string | null,"row_version"?: number,"source_file_id"?: string | null,"status"?: string,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string,"document_id"?: string,"facts"?: NonNullable<Json>,"facts_hash"?: string,"id"?: string,"legal_entity_id"?: string,"ready_run_id"?: string | null,"row_version"?: number,"source_file_id"?: string | null,"status"?: string,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_fact_drafts_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "itinerary_fact_drafts_legal_entity_id_document_id_fkey"
      columns: ["legal_entity_id","document_id"]
isOneToOne: false
      referencedRelation: "itinerary_documents"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_fact_drafts_legal_entity_id_source_file_id_fkey"
      columns: ["legal_entity_id","source_file_id"]
isOneToOne: false
      referencedRelation: "itinerary_source_files"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_fact_drafts_ready_run_fk"
      columns: ["legal_entity_id","ready_run_id"]
isOneToOne: false
      referencedRelation: "itinerary_difference_runs"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_fact_drafts_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"itinerary_render_jobs": {
                  Row: {
                    "attempts": number,"available_at": string,"basis_hash": string,"created_at": string,"document_id": string,"facts_hash": string,"finished_at": string | null,"id": string,"include_money": boolean,"input_hash": string,"kind": string,"last_error_code": string | null,"lease_owner": string | null,"lease_until": string | null,"legal_entity_id": string,"max_attempts": number,"requested_by": string,"started_at": string | null,"status": string,"template_version": string
                  }
                  Insert: {
                    "attempts"?: number,"available_at"?: string,"basis_hash": string,"created_at"?: string,"document_id": string,"facts_hash": string,"finished_at"?: string | null,"id"?: string,"include_money"?: boolean,"input_hash": string,"kind": string,"last_error_code"?: string | null,"lease_owner"?: string | null,"lease_until"?: string | null,"legal_entity_id": string,"max_attempts"?: number,"requested_by": string,"started_at"?: string | null,"status"?: string,"template_version": string
                  }
                  Update: {
                    "attempts"?: number,"available_at"?: string,"basis_hash"?: string,"created_at"?: string,"document_id"?: string,"facts_hash"?: string,"finished_at"?: string | null,"id"?: string,"include_money"?: boolean,"input_hash"?: string,"kind"?: string,"last_error_code"?: string | null,"lease_owner"?: string | null,"lease_until"?: string | null,"legal_entity_id"?: string,"max_attempts"?: number,"requested_by"?: string,"started_at"?: string | null,"status"?: string,"template_version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_render_jobs_legal_entity_id_document_id_fkey"
      columns: ["legal_entity_id","document_id"]
isOneToOne: false
      referencedRelation: "itinerary_documents"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_render_jobs_requested_by_fkey"
      columns: ["requested_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"itinerary_rendered_documents": {
                  Row: {
                    "created_at": string,"document_id": string,"id": string,"kind": string,"legal_entity_id": string,"object_path": string,"page_count": number,"qa": NonNullable<Json>,"render_job_id": string,"sha256": string,"size_bytes": number
                  }
                  Insert: {
                    "created_at"?: string,"document_id": string,"id"?: string,"kind": string,"legal_entity_id": string,"object_path": string,"page_count": number,"qa": NonNullable<Json>,"render_job_id": string,"sha256": string,"size_bytes": number
                  }
                  Update: {
                    "created_at"?: string,"document_id"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"object_path"?: string,"page_count"?: number,"qa"?: NonNullable<Json>,"render_job_id"?: string,"sha256"?: string,"size_bytes"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_rendered_documents_legal_entity_id_document_id_fkey"
      columns: ["legal_entity_id","document_id"]
isOneToOne: false
      referencedRelation: "itinerary_documents"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_rendered_documents_legal_entity_id_render_job_id_fkey"
      columns: ["legal_entity_id","render_job_id"]
isOneToOne: false
      referencedRelation: "itinerary_render_jobs"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"itinerary_source_files": {
                  Row: {
                    "created_at": string,"document_id": string,"file_name": string,"id": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "created_at"?: string,"document_id": string,"file_name": string,"id"?: string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "created_at"?: string,"document_id"?: string,"file_name"?: string,"id"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "itinerary_source_files_legal_entity_id_document_id_fkey"
      columns: ["legal_entity_id","document_id"]
isOneToOne: false
      referencedRelation: "itinerary_documents"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "itinerary_source_files_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"lead_source_facts": {
                  Row: {
                    "company_title": string | null,"created_at": string,"customer_type_enum_id": string | null,"lead_id": string,"legal_entity_id": string,"read_at": string,"read_issues": (string)[],"source_company_id": number | null,"source_contact_id": number | null,"source_contact_ids": (number)[],"source_modified_at": string
                  }
                  Insert: {
                    "company_title"?: string | null,"created_at"?: string,"customer_type_enum_id"?: string | null,"lead_id": string,"legal_entity_id": string,"read_at"?: string,"read_issues"?: (string)[],"source_company_id"?: number | null,"source_contact_id"?: number | null,"source_contact_ids"?: (number)[],"source_modified_at": string
                  }
                  Update: {
                    "company_title"?: string | null,"created_at"?: string,"customer_type_enum_id"?: string | null,"lead_id"?: string,"legal_entity_id"?: string,"read_at"?: string,"read_issues"?: (string)[],"source_company_id"?: number | null,"source_contact_id"?: number | null,"source_contact_ids"?: (number)[],"source_modified_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "lead_source_facts_lead_id_fkey"
      columns: ["lead_id"]
isOneToOne: true
      referencedRelation: "crm_leads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "lead_source_facts_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"legal_entities": {
                  Row: {
                    "code": string,"created_at": string,"id": string,"is_synthetic": boolean,"legal_name": string,"status": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"id"?: string,"is_synthetic"?: boolean,"legal_name": string,"status"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"id"?: string,"is_synthetic"?: boolean,"legal_name"?: string,"status"?: string
                  }
                  Relationships: [

                  ]
                },"memberships": {
                  Row: {
                    "branch_id": string,"created_at": string,"created_by": string | null,"deactivated_at": string | null,"id": string,"legal_entity_id": string,"role_code": string,"status": string,"user_id": string
                  }
                  Insert: {
                    "branch_id": string,"created_at"?: string,"created_by"?: string | null,"deactivated_at"?: string | null,"id"?: string,"legal_entity_id": string,"role_code": string,"status"?: string,"user_id": string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"created_by"?: string | null,"deactivated_at"?: string | null,"id"?: string,"legal_entity_id"?: string,"role_code"?: string,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "memberships_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "memberships_role_code_fkey"
      columns: ["role_code"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "memberships_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"mfa_recovery_cases": {
                  Row: {
                    "cleanup_completed_at": string | null,"cleanup_error": string | null,"code_regenerations": number,"completed_at": string | null,"completed_by": string | null,"confirm_failures": number,"confirmation_code": string | null,"id": string,"last_provider_error": string | null,"new_factor_id": string | null,"opened_at": string,"opened_by": string,"provider_attempts": number,"provider_completed_at": string | null,"reason": string,"recovery_session_id": string | null,"status": string,"updated_at": string,"user_id": string,"verification_method": string | null
                  }
                  Insert: {
                    "cleanup_completed_at"?: string | null,"cleanup_error"?: string | null,"code_regenerations"?: number,"completed_at"?: string | null,"completed_by"?: string | null,"confirm_failures"?: number,"confirmation_code"?: string | null,"id"?: string,"last_provider_error"?: string | null,"new_factor_id"?: string | null,"opened_at"?: string,"opened_by": string,"provider_attempts"?: number,"provider_completed_at"?: string | null,"reason": string,"recovery_session_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string,"verification_method"?: string | null
                  }
                  Update: {
                    "cleanup_completed_at"?: string | null,"cleanup_error"?: string | null,"code_regenerations"?: number,"completed_at"?: string | null,"completed_by"?: string | null,"confirm_failures"?: number,"confirmation_code"?: string | null,"id"?: string,"last_provider_error"?: string | null,"new_factor_id"?: string | null,"opened_at"?: string,"opened_by"?: string,"provider_attempts"?: number,"provider_completed_at"?: string | null,"reason"?: string,"recovery_session_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string,"verification_method"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "mfa_recovery_cases_completed_by_fkey"
      columns: ["completed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "mfa_recovery_cases_opened_by_fkey"
      columns: ["opened_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "mfa_recovery_cases_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "mfa_recovery_cases_verification_method_fkey"
      columns: ["verification_method"]
isOneToOne: false
      referencedRelation: "recovery_verification_methods"
      referencedColumns: ["code"]
    }
                  ]
                },"outbox_events": {
                  Row: {
                    "aggregate_id": string,"aggregate_type": string,"attempts": number,"created_at": string,"event_type": string,"id": string,"legal_entity_id": string,"payload": NonNullable<Json>,"status": string
                  }
                  Insert: {
                    "aggregate_id": string,"aggregate_type": string,"attempts"?: number,"created_at"?: string,"event_type": string,"id"?: string,"legal_entity_id": string,"payload": NonNullable<Json>,"status"?: string
                  }
                  Update: {
                    "aggregate_id"?: string,"aggregate_type"?: string,"attempts"?: number,"created_at"?: string,"event_type"?: string,"id"?: string,"legal_entity_id"?: string,"payload"?: NonNullable<Json>,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outbox_events_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"permissions": {
                  Row: {
                    "code": string,"description": string,"is_grantable": boolean
                  }
                  Insert: {
                    "code": string,"description": string,"is_grantable"?: boolean
                  }
                  Update: {
                    "code"?: string,"description"?: string,"is_grantable"?: boolean
                  }
                  Relationships: [

                  ]
                },"prefill_field_history": {
                  Row: {
                    "cleared_at": string | null,"cleared_by": string | null,"field_code": string,"first_staff_write_at": string | null,"last_staff_write_at": string | null,"last_staff_write_by": string | null,"legal_entity_id": string,"target_id": string,"target_kind": string
                  }
                  Insert: {
                    "cleared_at"?: string | null,"cleared_by"?: string | null,"field_code": string,"first_staff_write_at"?: string | null,"last_staff_write_at"?: string | null,"last_staff_write_by"?: string | null,"legal_entity_id": string,"target_id": string,"target_kind": string
                  }
                  Update: {
                    "cleared_at"?: string | null,"cleared_by"?: string | null,"field_code"?: string,"first_staff_write_at"?: string | null,"last_staff_write_at"?: string | null,"last_staff_write_by"?: string | null,"legal_entity_id"?: string,"target_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "prefill_field_history_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"prefill_fill_runs": {
                  Row: {
                    "filled": (string)[],"id": string,"legal_entity_id": string,"mode": string,"ran_at": string,"ran_by": string | null,"skipped": NonNullable<Json>,"source_modified_at": string | null,"source_object": string,"target_id": string,"target_kind": string
                  }
                  Insert: {
                    "filled"?: (string)[],"id"?: string,"legal_entity_id": string,"mode": string,"ran_at"?: string,"ran_by"?: string | null,"skipped"?: NonNullable<Json>,"source_modified_at"?: string | null,"source_object": string,"target_id": string,"target_kind": string
                  }
                  Update: {
                    "filled"?: (string)[],"id"?: string,"legal_entity_id"?: string,"mode"?: string,"ran_at"?: string,"ran_by"?: string | null,"skipped"?: NonNullable<Json>,"source_modified_at"?: string | null,"source_object"?: string,"target_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "prefill_fill_runs_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"prefill_history_settings": {
                  Row: {
                    "id": boolean,"started_at": string
                  }
                  Insert: {
                    "id"?: boolean,"started_at"?: string
                  }
                  Update: {
                    "id"?: boolean,"started_at"?: string
                  }
                  Relationships: [

                  ]
                },"prefill_marks": {
                  Row: {
                    "applied_at": string,"applied_by": string,"applied_via": string,"checked_at": string | null,"checked_by": string | null,"field_code": string,"id": string,"legal_entity_id": string,"source_modified_at": string | null,"source_object": string,"state": string,"target_id": string,"target_kind": string
                  }
                  Insert: {
                    "applied_at"?: string,"applied_by": string,"applied_via"?: string,"checked_at"?: string | null,"checked_by"?: string | null,"field_code": string,"id"?: string,"legal_entity_id": string,"source_modified_at"?: string | null,"source_object": string,"state": string,"target_id": string,"target_kind": string
                  }
                  Update: {
                    "applied_at"?: string,"applied_by"?: string,"applied_via"?: string,"checked_at"?: string | null,"checked_by"?: string | null,"field_code"?: string,"id"?: string,"legal_entity_id"?: string,"source_modified_at"?: string | null,"source_object"?: string,"state"?: string,"target_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "prefill_marks_applied_by_fkey"
      columns: ["applied_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "prefill_marks_checked_by_fkey"
      columns: ["checked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "prefill_marks_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"prefill_notice_dismissals": {
                  Row: {
                    "dismissed_at": string,"dismissed_by": string | null,"field_code": string,"id": string,"legal_entity_id": string,"source_modified_at": string,"target_id": string,"target_kind": string
                  }
                  Insert: {
                    "dismissed_at"?: string,"dismissed_by"?: string | null,"field_code": string,"id"?: string,"legal_entity_id": string,"source_modified_at": string,"target_id": string,"target_kind": string
                  }
                  Update: {
                    "dismissed_at"?: string,"dismissed_by"?: string | null,"field_code"?: string,"id"?: string,"legal_entity_id"?: string,"source_modified_at"?: string,"target_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "prefill_notice_dismissals_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"procurement_settings": {
                  Row: {
                    "id": boolean,"live_supplier_confirmation_enabled": boolean,"updated_at": string
                  }
                  Insert: {
                    "id"?: boolean,"live_supplier_confirmation_enabled"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "id"?: boolean,"live_supplier_confirmation_enabled"?: boolean,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"purchase_cost_approvals": {
                  Row: {
                    "approved_at": string,"approved_by": string,"id": string,"legal_entity_id": string,"task_id": string,"version_no": number
                  }
                  Insert: {
                    "approved_at"?: string,"approved_by": string,"id"?: string,"legal_entity_id": string,"task_id": string,"version_no": number
                  }
                  Update: {
                    "approved_at"?: string,"approved_by"?: string,"id"?: string,"legal_entity_id"?: string,"task_id"?: string,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_cost_approvals_approved_by_fkey"
      columns: ["approved_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "purchase_cost_approvals_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "purchase_cost_approvals_task_id_version_no_fkey"
      columns: ["task_id","version_no"]
isOneToOne: true
      referencedRelation: "purchase_cost_versions"
      referencedColumns: ["task_id","version_no"]
    }
                  ]
                },"purchase_cost_versions": {
                  Row: {
                    "amount_paise": number,"created_at": string,"created_by": string,"currency": string,"due_date": string | null,"id": string,"legal_entity_id": string,"note": string | null,"payable_status": string,"quote_id": string,"request_id": string,"stage": string,"task_id": string,"version_no": number
                  }
                  Insert: {
                    "amount_paise": number,"created_at"?: string,"created_by": string,"currency"?: string,"due_date"?: string | null,"id"?: string,"legal_entity_id": string,"note"?: string | null,"payable_status"?: string,"quote_id": string,"request_id": string,"stage": string,"task_id": string,"version_no": number
                  }
                  Update: {
                    "amount_paise"?: number,"created_at"?: string,"created_by"?: string,"currency"?: string,"due_date"?: string | null,"id"?: string,"legal_entity_id"?: string,"note"?: string | null,"payable_status"?: string,"quote_id"?: string,"request_id"?: string,"stage"?: string,"task_id"?: string,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_cost_versions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "purchase_cost_versions_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "purchase_cost_versions_task_id_quote_id_fkey"
      columns: ["task_id","quote_id"]
isOneToOne: false
      referencedRelation: "purchase_quotes"
      referencedColumns: ["task_id","id"]
    }
                  ]
                },"purchase_evidence": {
                  Row: {
                    "created_at": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"task_id": string,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "created_at"?: string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"task_id": string,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "created_at"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"task_id"?: string,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_evidence_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "purchase_evidence_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"purchase_quotes": {
                  Row: {
                    "cancellation_terms": string | null,"created_at": string,"created_by": string,"currency": string,"hold_until": string | null,"hotel_name": string,"id": string,"legal_entity_id": string,"meal_plan": string | null,"quoted_cost_paise": number,"request_id": string,"room_type": string | null,"status": string,"supplier_id": string,"task_id": string,"updated_at": string
                  }
                  Insert: {
                    "cancellation_terms"?: string | null,"created_at"?: string,"created_by": string,"currency"?: string,"hold_until"?: string | null,"hotel_name": string,"id"?: string,"legal_entity_id": string,"meal_plan"?: string | null,"quoted_cost_paise": number,"request_id": string,"room_type"?: string | null,"status"?: string,"supplier_id": string,"task_id": string,"updated_at"?: string
                  }
                  Update: {
                    "cancellation_terms"?: string | null,"created_at"?: string,"created_by"?: string,"currency"?: string,"hold_until"?: string | null,"hotel_name"?: string,"id"?: string,"legal_entity_id"?: string,"meal_plan"?: string | null,"quoted_cost_paise"?: number,"request_id"?: string,"room_type"?: string | null,"status"?: string,"supplier_id"?: string,"task_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_quotes_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "purchase_quotes_legal_entity_id_supplier_id_fkey"
      columns: ["legal_entity_id","supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "purchase_quotes_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"quotation_conversion_items": {
                  Row: {
                    "conversion_id": string,"quotation_item_id": string,"service_item_id": string
                  }
                  Insert: {
                    "conversion_id": string,"quotation_item_id": string,"service_item_id": string
                  }
                  Update: {
                    "conversion_id"?: string,"quotation_item_id"?: string,"service_item_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_conversion_items_conversion_id_fkey"
      columns: ["conversion_id"]
isOneToOne: false
      referencedRelation: "quotation_conversions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quotation_conversion_items_quotation_item_id_fkey"
      columns: ["quotation_item_id"]
isOneToOne: false
      referencedRelation: "quotation_version_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quotation_conversion_items_service_item_id_fkey"
      columns: ["service_item_id"]
isOneToOne: true
      referencedRelation: "service_items"
      referencedColumns: ["id"]
    }
                  ]
                },"quotation_conversions": {
                  Row: {
                    "accepted_tier": string,"booking_version_id": string,"created_at": string,"created_by": string,"deal_id": string,"facts_signature": string | null,"id": string,"items_created": number,"legal_entity_id": string,"minor_signature": string | null,"money_signature": string | null,"quotation_id": string,"quotation_version_id": string,"request_id": string
                  }
                  Insert: {
                    "accepted_tier": string,"booking_version_id": string,"created_at"?: string,"created_by": string,"deal_id": string,"facts_signature"?: string | null,"id"?: string,"items_created"?: number,"legal_entity_id": string,"minor_signature"?: string | null,"money_signature"?: string | null,"quotation_id": string,"quotation_version_id": string,"request_id": string
                  }
                  Update: {
                    "accepted_tier"?: string,"booking_version_id"?: string,"created_at"?: string,"created_by"?: string,"deal_id"?: string,"facts_signature"?: string | null,"id"?: string,"items_created"?: number,"legal_entity_id"?: string,"minor_signature"?: string | null,"money_signature"?: string | null,"quotation_id"?: string,"quotation_version_id"?: string,"request_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_conversions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_conversions_legal_entity_id_deal_id_booking_vers_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "quotation_conversions_legal_entity_id_quotation_id_fkey"
      columns: ["legal_entity_id","quotation_id"]
isOneToOne: false
      referencedRelation: "quotations"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_conversions_legal_entity_id_quotation_version_id_fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"quotation_counters": {
                  Row: {
                    "last_no": number,"legal_entity_id": string
                  }
                  Insert: {
                    "last_no"?: number,"legal_entity_id": string
                  }
                  Update: {
                    "last_no"?: number,"legal_entity_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_counters_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"quotation_evidence": {
                  Row: {
                    "created_at": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"quotation_id": string,"quotation_version_id": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "created_at"?: string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"quotation_id": string,"quotation_version_id": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "created_at"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"quotation_id"?: string,"quotation_version_id"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_evidence_legal_entity_id_quotation_id_fkey"
      columns: ["legal_entity_id","quotation_id"]
isOneToOne: false
      referencedRelation: "quotations"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_evidence_legal_entity_id_quotation_version_id_fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_evidence_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"quotation_version_contacts": {
                  Row: {
                    "booking_for": string | null,"company_name": string | null,"contact_name": string,"created_at": string,"email": string | null,"legal_entity_id": string,"mobile": string | null,"quotation_version_id": string,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "booking_for"?: string | null,"company_name"?: string | null,"contact_name": string,"created_at"?: string,"email"?: string | null,"legal_entity_id": string,"mobile"?: string | null,"quotation_version_id": string,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "booking_for"?: string | null,"company_name"?: string | null,"contact_name"?: string,"created_at"?: string,"email"?: string | null,"legal_entity_id"?: string,"mobile"?: string | null,"quotation_version_id"?: string,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_contacts_legal_entity_id_quotation_versi_fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_version_contacts_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"quotation_version_instalments": {
                  Row: {
                    "amount_paise": number,"created_at": string,"due_date": string | null,"due_days": number | null,"due_rule": string,"id": string,"label": string,"legal_entity_id": string,"quotation_version_id": string,"seq": number,"tier_key": string
                  }
                  Insert: {
                    "amount_paise": number,"created_at"?: string,"due_date"?: string | null,"due_days"?: number | null,"due_rule": string,"id"?: string,"label": string,"legal_entity_id": string,"quotation_version_id": string,"seq": number,"tier_key": string
                  }
                  Update: {
                    "amount_paise"?: number,"created_at"?: string,"due_date"?: string | null,"due_days"?: number | null,"due_rule"?: string,"id"?: string,"label"?: string,"legal_entity_id"?: string,"quotation_version_id"?: string,"seq"?: number,"tier_key"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_instalments_legal_entity_id_quotation_ve_fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"quotation_version_items": {
                  Row: {
                    "created_at": string,"facts": NonNullable<Json>,"id": string,"item_no": number,"legal_entity_id": string,"quotation_version_id": string,"service_type": string,"tier_key": string | null,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"facts": NonNullable<Json>,"id"?: string,"item_no": number,"legal_entity_id": string,"quotation_version_id": string,"service_type": string,"tier_key"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"facts"?: NonNullable<Json>,"id"?: string,"item_no"?: number,"legal_entity_id"?: string,"quotation_version_id"?: string,"service_type"?: string,"tier_key"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_items_legal_entity_id_quotation_version__fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"quotation_version_lines": {
                  Row: {
                    "category_key": string,"charge_kind": string,"created_at": string,"created_by": string,"description": string,"id": string,"item_id": string | null,"legal_entity_id": string,"line_cost_paise": number | null,"line_no": number,"line_sell_paise": number | null,"option_key": string,"periods": number,"quotation_version_id": string,"remark": string | null,"unit_cost_paise": number | null,"unit_kind": string,"unit_sell_paise": number,"units": number,"updated_at": string
                  }
                  Insert: {
                    "category_key": string,"charge_kind"?: string,"created_at"?: string,"created_by": string,"description": string,"id"?: string,"item_id"?: string | null,"legal_entity_id": string,"line_cost_paise"?: never,"line_no": number,"line_sell_paise"?: never,"option_key": string,"periods": number,"quotation_version_id": string,"remark"?: string | null,"unit_cost_paise"?: number | null,"unit_kind": string,"unit_sell_paise": number,"units": number,"updated_at"?: string
                  }
                  Update: {
                    "category_key"?: string,"charge_kind"?: string,"created_at"?: string,"created_by"?: string,"description"?: string,"id"?: string,"item_id"?: string | null,"legal_entity_id"?: string,"line_cost_paise"?: never,"line_no"?: number,"line_sell_paise"?: never,"option_key"?: string,"periods"?: number,"quotation_version_id"?: string,"remark"?: string | null,"unit_cost_paise"?: number | null,"unit_kind"?: string,"unit_sell_paise"?: number,"units"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_lines_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_version_lines_legal_entity_id_quotation_version__fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_version_lines_legal_entity_id_quotation_version_fkey1"
      columns: ["legal_entity_id","quotation_version_id","item_id"]
isOneToOne: false
      referencedRelation: "quotation_version_items"
      referencedColumns: ["legal_entity_id","quotation_version_id","id"]
    }
                  ]
                },"quotation_version_tier_money": {
                  Row: {
                    "legal_entity_id": string,"quotation_version_id": string,"quoted_total_paise": number,"show_per_person": boolean,"tier_key": string,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "legal_entity_id": string,"quotation_version_id": string,"quoted_total_paise": number,"show_per_person"?: boolean,"tier_key": string,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "legal_entity_id"?: string,"quotation_version_id"?: string,"quoted_total_paise"?: number,"show_per_person"?: boolean,"tier_key"?: string,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_tier_money_legal_entity_id_quotation_ver_fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_version_tier_money_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"quotation_version_tiers": {
                  Row: {
                    "created_at": string,"label": string | null,"legal_entity_id": string,"quotation_version_id": string,"tier_key": string
                  }
                  Insert: {
                    "created_at"?: string,"label"?: string | null,"legal_entity_id": string,"quotation_version_id": string,"tier_key": string
                  }
                  Update: {
                    "created_at"?: string,"label"?: string | null,"legal_entity_id"?: string,"quotation_version_id"?: string,"tier_key"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_version_tiers_legal_entity_id_quotation_version__fkey"
      columns: ["legal_entity_id","quotation_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"quotation_versions": {
                  Row: {
                    "acceptance_evidence_id": string | null,"accepted_at": string | null,"accepted_by": string | null,"accepted_tier": string | null,"adults": number,"based_on_version_id": string | null,"children_no_bed": number,"children_with_bed": number,"content": NonNullable<Json>,"content_hash": string | null,"created_at": string,"created_by": string,"decline_reason": string | null,"declined_at": string | null,"declined_by": string | null,"discarded_at": string | null,"discarded_by": string | null,"expired_at": string | null,"id": string,"infants": number,"legal_entity_id": string,"pax_remarks": string | null,"quotation_id": string,"requirements_note": string | null,"row_version": number,"sent_at": string | null,"sent_by": string | null,"sent_channel": string | null,"status": string,"superseded_at": string | null,"superseded_by_version_id": string | null,"trip_destination": string | null,"trip_end": string | null,"trip_scope": string | null,"trip_start": string | null,"updated_at": string,"updated_by": string,"valid_until": string,"version_no": number
                  }
                  Insert: {
                    "acceptance_evidence_id"?: string | null,"accepted_at"?: string | null,"accepted_by"?: string | null,"accepted_tier"?: string | null,"adults"?: number,"based_on_version_id"?: string | null,"children_no_bed"?: number,"children_with_bed"?: number,"content"?: NonNullable<Json>,"content_hash"?: string | null,"created_at"?: string,"created_by": string,"decline_reason"?: string | null,"declined_at"?: string | null,"declined_by"?: string | null,"discarded_at"?: string | null,"discarded_by"?: string | null,"expired_at"?: string | null,"id"?: string,"infants"?: number,"legal_entity_id": string,"pax_remarks"?: string | null,"quotation_id": string,"requirements_note"?: string | null,"row_version"?: number,"sent_at"?: string | null,"sent_by"?: string | null,"sent_channel"?: string | null,"status"?: string,"superseded_at"?: string | null,"superseded_by_version_id"?: string | null,"trip_destination"?: string | null,"trip_end"?: string | null,"trip_scope"?: string | null,"trip_start"?: string | null,"updated_at"?: string,"updated_by": string,"valid_until"?: string,"version_no": number
                  }
                  Update: {
                    "acceptance_evidence_id"?: string | null,"accepted_at"?: string | null,"accepted_by"?: string | null,"accepted_tier"?: string | null,"adults"?: number,"based_on_version_id"?: string | null,"children_no_bed"?: number,"children_with_bed"?: number,"content"?: NonNullable<Json>,"content_hash"?: string | null,"created_at"?: string,"created_by"?: string,"decline_reason"?: string | null,"declined_at"?: string | null,"declined_by"?: string | null,"discarded_at"?: string | null,"discarded_by"?: string | null,"expired_at"?: string | null,"id"?: string,"infants"?: number,"legal_entity_id"?: string,"pax_remarks"?: string | null,"quotation_id"?: string,"requirements_note"?: string | null,"row_version"?: number,"sent_at"?: string | null,"sent_by"?: string | null,"sent_channel"?: string | null,"status"?: string,"superseded_at"?: string | null,"superseded_by_version_id"?: string | null,"trip_destination"?: string | null,"trip_end"?: string | null,"trip_scope"?: string | null,"trip_start"?: string | null,"updated_at"?: string,"updated_by"?: string,"valid_until"?: string,"version_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotation_versions_accepted_by_fkey"
      columns: ["accepted_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_versions_based_on_fk"
      columns: ["legal_entity_id","based_on_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_versions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_versions_declined_by_fkey"
      columns: ["declined_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_versions_discarded_by_fkey"
      columns: ["discarded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_versions_evidence_fk"
      columns: ["legal_entity_id","acceptance_evidence_id"]
isOneToOne: false
      referencedRelation: "quotation_evidence"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_versions_legal_entity_id_quotation_id_fkey"
      columns: ["legal_entity_id","quotation_id"]
isOneToOne: false
      referencedRelation: "quotations"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_versions_sent_by_fkey"
      columns: ["sent_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotation_versions_superseded_by_fk"
      columns: ["legal_entity_id","superseded_by_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotation_versions_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"quotations": {
                  Row: {
                    "accepted_version_id": string | null,"branch_id": string,"converted_at": string | null,"created_at": string,"created_by": string,"deal_id": string | null,"id": string,"lead_id": string | null,"legal_entity_id": string,"linked_at": string | null,"linked_by": string | null,"linked_deal_id": string | null,"owner_user_id": string | null,"quote_no": number,"reference": string,"referral_draft_id": string | null,"request_id": string,"row_version": number,"title": string,"updated_at": string
                  }
                  Insert: {
                    "accepted_version_id"?: string | null,"branch_id": string,"converted_at"?: string | null,"created_at"?: string,"created_by": string,"deal_id"?: string | null,"id"?: string,"lead_id"?: string | null,"legal_entity_id": string,"linked_at"?: string | null,"linked_by"?: string | null,"linked_deal_id"?: string | null,"owner_user_id"?: string | null,"quote_no": number,"reference": string,"referral_draft_id"?: string | null,"request_id": string,"row_version"?: number,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "accepted_version_id"?: string | null,"branch_id"?: string,"converted_at"?: string | null,"created_at"?: string,"created_by"?: string,"deal_id"?: string | null,"id"?: string,"lead_id"?: string | null,"legal_entity_id"?: string,"linked_at"?: string | null,"linked_by"?: string | null,"linked_deal_id"?: string | null,"owner_user_id"?: string | null,"quote_no"?: number,"reference"?: string,"referral_draft_id"?: string | null,"request_id"?: string,"row_version"?: number,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "quotations_accepted_version_fk"
      columns: ["legal_entity_id","accepted_version_id"]
isOneToOne: false
      referencedRelation: "quotation_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotations_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotations_lead_id_fkey"
      columns: ["lead_id"]
isOneToOne: false
      referencedRelation: "crm_leads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "quotations_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotations_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotations_legal_entity_id_linked_deal_id_fkey"
      columns: ["legal_entity_id","linked_deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "quotations_linked_by_fkey"
      columns: ["linked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotations_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "quotations_referral_draft_fk"
      columns: ["legal_entity_id","referral_draft_id"]
isOneToOne: false
      referencedRelation: "referral_drafts"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"recovery_verification_methods": {
                  Row: {
                    "active": boolean,"code": string,"created_at": string,"label": string
                  }
                  Insert: {
                    "active"?: boolean,"code": string,"created_at"?: string,"label": string
                  }
                  Update: {
                    "active"?: boolean,"code"?: string,"created_at"?: string,"label"?: string
                  }
                  Relationships: [

                  ]
                },"referral_draft_counters": {
                  Row: {
                    "last_no": number,"legal_entity_id": string
                  }
                  Insert: {
                    "last_no"?: number,"legal_entity_id": string
                  }
                  Update: {
                    "last_no"?: number,"legal_entity_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "referral_draft_counters_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: true
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"referral_draft_links": {
                  Row: {
                    "deal_id": string | null,"end_note": string | null,"end_reason": string | null,"ended_at": string | null,"ended_by": string | null,"id": string,"lead_id": string | null,"legal_entity_id": string,"link_note": string | null,"linked_at": string,"linked_by": string,"referral_draft_id": string,"target_kind": string
                  }
                  Insert: {
                    "deal_id"?: string | null,"end_note"?: string | null,"end_reason"?: string | null,"ended_at"?: string | null,"ended_by"?: string | null,"id"?: string,"lead_id"?: string | null,"legal_entity_id": string,"link_note"?: string | null,"linked_at"?: string,"linked_by": string,"referral_draft_id": string,"target_kind": string
                  }
                  Update: {
                    "deal_id"?: string | null,"end_note"?: string | null,"end_reason"?: string | null,"ended_at"?: string | null,"ended_by"?: string | null,"id"?: string,"lead_id"?: string | null,"legal_entity_id"?: string,"link_note"?: string | null,"linked_at"?: string,"linked_by"?: string,"referral_draft_id"?: string,"target_kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "referral_draft_links_ended_by_fkey"
      columns: ["ended_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "referral_draft_links_lead_id_fkey"
      columns: ["lead_id"]
isOneToOne: false
      referencedRelation: "crm_leads"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "referral_draft_links_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "referral_draft_links_legal_entity_id_referral_draft_id_fkey"
      columns: ["legal_entity_id","referral_draft_id"]
isOneToOne: false
      referencedRelation: "referral_drafts"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "referral_draft_links_linked_by_fkey"
      columns: ["linked_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"referral_drafts": {
                  Row: {
                    "branch_id": string,"close_note": string | null,"closed_at": string | null,"closed_by": string | null,"closed_due_on": string | null,"closed_reason": string | null,"company_name": string | null,"created_at": string,"created_by": string,"created_via": string,"customer_name": string,"draft_no": number,"email": string | null,"id": string,"last_activity_at": string,"legal_entity_id": string,"mobile": string | null,"owner_user_id": string,"reference": string,"request_id": string,"row_version": number,"source_kind": string | null,"source_note": string | null,"status": string,"updated_at": string
                  }
                  Insert: {
                    "branch_id": string,"close_note"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"closed_due_on"?: string | null,"closed_reason"?: string | null,"company_name"?: string | null,"created_at"?: string,"created_by": string,"created_via": string,"customer_name": string,"draft_no": number,"email"?: string | null,"id"?: string,"last_activity_at"?: string,"legal_entity_id": string,"mobile"?: string | null,"owner_user_id": string,"reference": string,"request_id": string,"row_version"?: number,"source_kind"?: string | null,"source_note"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "branch_id"?: string,"close_note"?: string | null,"closed_at"?: string | null,"closed_by"?: string | null,"closed_due_on"?: string | null,"closed_reason"?: string | null,"company_name"?: string | null,"created_at"?: string,"created_by"?: string,"created_via"?: string,"customer_name"?: string,"draft_no"?: number,"email"?: string | null,"id"?: string,"last_activity_at"?: string,"legal_entity_id"?: string,"mobile"?: string | null,"owner_user_id"?: string,"reference"?: string,"request_id"?: string,"row_version"?: number,"source_kind"?: string | null,"source_note"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "referral_drafts_closed_by_fkey"
      columns: ["closed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "referral_drafts_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "referral_drafts_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "referral_drafts_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"role_permissions": {
                  Row: {
                    "note": string | null,"permission_code": string,"policy_status": string,"role_code": string,"scope": string
                  }
                  Insert: {
                    "note"?: string | null,"permission_code": string,"policy_status": string,"role_code": string,"scope": string
                  }
                  Update: {
                    "note"?: string | null,"permission_code"?: string,"policy_status"?: string,"role_code"?: string,"scope"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_permissions_permission_code_fkey"
      columns: ["permission_code"]
isOneToOne: false
      referencedRelation: "permissions"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "role_permissions_role_code_fkey"
      columns: ["role_code"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["code"]
    }
                  ]
                },"roles": {
                  Row: {
                    "code": string,"description": string,"name": string,"policy_status": string
                  }
                  Insert: {
                    "code": string,"description": string,"name": string,"policy_status": string
                  }
                  Update: {
                    "code"?: string,"description"?: string,"name"?: string,"policy_status"?: string
                  }
                  Relationships: [

                  ]
                },"security_policy": {
                  Row: {
                    "id": boolean,"policy_status": string,"session_max_age_seconds": number,"updated_at": string
                  }
                  Insert: {
                    "id"?: boolean,"policy_status"?: string,"session_max_age_seconds"?: number,"updated_at"?: string
                  }
                  Update: {
                    "id"?: boolean,"policy_status"?: string,"session_max_age_seconds"?: number,"updated_at"?: string
                  }
                  Relationships: [

                  ]
                },"service_item_cost_estimates": {
                  Row: {
                    "booking_version_id": string,"created_at": string,"extra_bed_rate_paise": number | null,"fare_total_paise": number | null,"legal_entity_id": string,"no_bed_rate_paise": number | null,"room_rate_paise": number | null,"service_item_id": string,"updated_at": string,"updated_by": string,"vehicle_rate_paise": number | null
                  }
                  Insert: {
                    "booking_version_id": string,"created_at"?: string,"extra_bed_rate_paise"?: number | null,"fare_total_paise"?: number | null,"legal_entity_id": string,"no_bed_rate_paise"?: number | null,"room_rate_paise"?: number | null,"service_item_id": string,"updated_at"?: string,"updated_by": string,"vehicle_rate_paise"?: number | null
                  }
                  Update: {
                    "booking_version_id"?: string,"created_at"?: string,"extra_bed_rate_paise"?: number | null,"fare_total_paise"?: number | null,"legal_entity_id"?: string,"no_bed_rate_paise"?: number | null,"room_rate_paise"?: number | null,"service_item_id"?: string,"updated_at"?: string,"updated_by"?: string,"vehicle_rate_paise"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_item_cost_estimates_legal_entity_id_service_item_i_fkey"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "service_item_cost_estimates_service_item_id_booking_versio_fkey"
      columns: ["service_item_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "service_item_facts"
      referencedColumns: ["service_item_id","booking_version_id"]
    },{
      foreignKeyName: "service_item_cost_estimates_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"service_item_facts": {
                  Row: {
                    "adults_from_booking": boolean,"booking_version_id": string,"created_at": string,"facts": NonNullable<Json>,"facts_hash": string,"id": string,"legal_entity_id": string,"purchase_budget_paise": number,"service_item_id": string,"updated_at": string
                  }
                  Insert: {
                    "adults_from_booking"?: boolean,"booking_version_id": string,"created_at"?: string,"facts": NonNullable<Json>,"facts_hash": string,"id"?: string,"legal_entity_id": string,"purchase_budget_paise"?: number,"service_item_id": string,"updated_at"?: string
                  }
                  Update: {
                    "adults_from_booking"?: boolean,"booking_version_id"?: string,"created_at"?: string,"facts"?: NonNullable<Json>,"facts_hash"?: string,"id"?: string,"legal_entity_id"?: string,"purchase_budget_paise"?: number,"service_item_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_item_facts_legal_entity_id_booking_version_id_fkey"
      columns: ["legal_entity_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "service_item_facts_legal_entity_id_service_item_id_fkey"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"service_item_files": {
                  Row: {
                    "booking_version_id": string,"created_at": string,"deal_id": string,"file_name": string,"id": string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"removed_at": string | null,"removed_by": string | null,"request_id": string,"row_version": number,"service_item_id": string,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "booking_version_id": string,"created_at"?: string,"deal_id": string,"file_name": string,"id"?: string,"kind": string,"legal_entity_id": string,"mime": string,"object_path": string,"removed_at"?: string | null,"removed_by"?: string | null,"request_id": string,"row_version"?: number,"service_item_id": string,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "booking_version_id"?: string,"created_at"?: string,"deal_id"?: string,"file_name"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"removed_at"?: string | null,"removed_by"?: string | null,"request_id"?: string,"row_version"?: number,"service_item_id"?: string,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_item_files_legal_entity_id_deal_id_booking_version_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "service_item_files_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "service_item_files_legal_entity_id_service_item_id_fkey"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "service_item_files_removed_by_fkey"
      columns: ["removed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "service_item_files_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"service_item_travellers": {
                  Row: {
                    "booking_version_id": string,"created_at": string,"legal_entity_id": string,"service_item_id": string,"traveller_seq": number
                  }
                  Insert: {
                    "booking_version_id": string,"created_at"?: string,"legal_entity_id": string,"service_item_id": string,"traveller_seq": number
                  }
                  Update: {
                    "booking_version_id"?: string,"created_at"?: string,"legal_entity_id"?: string,"service_item_id"?: string,"traveller_seq"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_item_travellers_legal_entity_id_service_item_id_fkey"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "service_item_travellers_service_item_id_booking_version_id_fkey"
      columns: ["service_item_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "service_item_facts"
      referencedColumns: ["service_item_id","booking_version_id"]
    }
                  ]
                },"service_items": {
                  Row: {
                    "branch_id": string,"created_at": string,"created_by": string,"deal_id": string,"department": string,"id": string,"item_no": number,"legal_entity_id": string,"request_id": string | null,"service_type": string,"state": string,"updated_at": string
                  }
                  Insert: {
                    "branch_id": string,"created_at"?: string,"created_by": string,"deal_id": string,"department": string,"id"?: string,"item_no": number,"legal_entity_id": string,"request_id"?: string | null,"service_type": string,"state"?: string,"updated_at"?: string
                  }
                  Update: {
                    "branch_id"?: string,"created_at"?: string,"created_by"?: string,"deal_id"?: string,"department"?: string,"id"?: string,"item_no"?: number,"legal_entity_id"?: string,"request_id"?: string | null,"service_type"?: string,"state"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_items_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "service_items_legal_entity_id_branch_id_deal_id_fkey"
      columns: ["legal_entity_id","branch_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","branch_id","id"]
    }
                  ]
                },"staff_email_deliveries": {
                  Row: {
                    "attempt_no": number,"completed_at": string | null,"created_at": string,"created_by": string | null,"error_code": string | null,"id": string,"invitation_id": string | null,"kind": string,"status": string,"user_id": string | null
                  }
                  Insert: {
                    "attempt_no": number,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"error_code"?: string | null,"id"?: string,"invitation_id"?: string | null,"kind": string,"status"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "attempt_no"?: number,"completed_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"error_code"?: string | null,"id"?: string,"invitation_id"?: string | null,"kind"?: string,"status"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_email_deliveries_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "staff_email_deliveries_invitation_id_fkey"
      columns: ["invitation_id"]
isOneToOne: false
      referencedRelation: "staff_invitations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "staff_email_deliveries_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"staff_invitations": {
                  Row: {
                    "accepted_at": string | null,"branch_id": string,"created_at": string,"display_name": string,"email": string,"id": string,"invited_by": string,"legal_entity_id": string,"role_code": string,"sent_at": string | null,"status": string,"user_id": string | null
                  }
                  Insert: {
                    "accepted_at"?: string | null,"branch_id": string,"created_at"?: string,"display_name": string,"email": string,"id"?: string,"invited_by": string,"legal_entity_id": string,"role_code": string,"sent_at"?: string | null,"status"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "accepted_at"?: string | null,"branch_id"?: string,"created_at"?: string,"display_name"?: string,"email"?: string,"id"?: string,"invited_by"?: string,"legal_entity_id"?: string,"role_code"?: string,"sent_at"?: string | null,"status"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_invitations_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "staff_invitations_legal_entity_id_branch_id_fkey"
      columns: ["legal_entity_id","branch_id"]
isOneToOne: false
      referencedRelation: "branches"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "staff_invitations_role_code_fkey"
      columns: ["role_code"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "staff_invitations_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"staff_profiles": {
                  Row: {
                    "activated_at": string | null,"created_at": string,"deactivated_at": string | null,"deactivation_reason": string | null,"display_name": string,"status": string,"user_id": string,"work_email": string
                  }
                  Insert: {
                    "activated_at"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"deactivation_reason"?: string | null,"display_name": string,"status"?: string,"user_id": string,"work_email": string
                  }
                  Update: {
                    "activated_at"?: string | null,"created_at"?: string,"deactivated_at"?: string | null,"deactivation_reason"?: string | null,"display_name"?: string,"status"?: string,"user_id"?: string,"work_email"?: string
                  }
                  Relationships: [

                  ]
                },"staff_security_state": {
                  Row: {
                    "sessions_valid_after": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "sessions_valid_after"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "sessions_valid_after"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_security_state_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"supplier_beneficiary_revisions": {
                  Row: {
                    "account_holder": string,"account_number": string,"approved_at": string | null,"approved_by": string | null,"bank_name": string,"created_at": string,"created_by": string,"id": string,"ifsc": string,"legal_entity_id": string,"request_id": string,"revision_no": number,"status": string,"supplier_id": string
                  }
                  Insert: {
                    "account_holder": string,"account_number": string,"approved_at"?: string | null,"approved_by"?: string | null,"bank_name": string,"created_at"?: string,"created_by": string,"id"?: string,"ifsc": string,"legal_entity_id": string,"request_id": string,"revision_no": number,"status"?: string,"supplier_id": string
                  }
                  Update: {
                    "account_holder"?: string,"account_number"?: string,"approved_at"?: string | null,"approved_by"?: string | null,"bank_name"?: string,"created_at"?: string,"created_by"?: string,"id"?: string,"ifsc"?: string,"legal_entity_id"?: string,"request_id"?: string,"revision_no"?: number,"status"?: string,"supplier_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_beneficiary_revisions_approved_by_fkey"
      columns: ["approved_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "supplier_beneficiary_revisions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "supplier_beneficiary_revisions_legal_entity_id_supplier_id_fkey"
      columns: ["legal_entity_id","supplier_id"]
isOneToOne: false
      referencedRelation: "suppliers"
      referencedColumns: ["legal_entity_id","id"]
    }
                  ]
                },"suppliers": {
                  Row: {
                    "city": string | null,"contact_email": string | null,"contact_name": string | null,"contact_phone": string | null,"created_at": string,"created_by": string,"id": string,"legal_entity_id": string,"name": string,"payment_terms": string | null,"row_version": number,"service_types": (string)[],"status": string,"updated_at": string,"updated_by": string,"verification_status": string,"verified_at": string | null,"verified_by": string | null
                  }
                  Insert: {
                    "city"?: string | null,"contact_email"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"created_by": string,"id"?: string,"legal_entity_id": string,"name": string,"payment_terms"?: string | null,"row_version"?: number,"service_types": (string)[],"status"?: string,"updated_at"?: string,"updated_by": string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "city"?: string | null,"contact_email"?: string | null,"contact_name"?: string | null,"contact_phone"?: string | null,"created_at"?: string,"created_by"?: string,"id"?: string,"legal_entity_id"?: string,"name"?: string,"payment_terms"?: string | null,"row_version"?: number,"service_types"?: (string)[],"status"?: string,"updated_at"?: string,"updated_by"?: string,"verification_status"?: string,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "suppliers_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "suppliers_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suppliers_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "suppliers_verified_by_fkey"
      columns: ["verified_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"traveller_id_proofs": {
                  Row: {
                    "booking_version_id": string | null,"consent_at": string,"consent_by": string,"created_at": string,"deal_id": string,"file_name": string,"id": string,"legal_entity_id": string,"mime": string,"object_path": string,"removed_at": string | null,"removed_by": string | null,"removed_reason": string | null,"request_id": string,"row_version": number,"sha256": string,"size_bytes": number,"status": string,"stored_at": string | null,"traveller_id": string,"traveller_seq": number,"updated_at": string,"uploaded_by": string
                  }
                  Insert: {
                    "booking_version_id"?: string | null,"consent_at": string,"consent_by": string,"created_at"?: string,"deal_id": string,"file_name": string,"id"?: string,"legal_entity_id": string,"mime": string,"object_path": string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"request_id": string,"row_version"?: number,"sha256": string,"size_bytes": number,"status"?: string,"stored_at"?: string | null,"traveller_id": string,"traveller_seq": number,"updated_at"?: string,"uploaded_by": string
                  }
                  Update: {
                    "booking_version_id"?: string | null,"consent_at"?: string,"consent_by"?: string,"created_at"?: string,"deal_id"?: string,"file_name"?: string,"id"?: string,"legal_entity_id"?: string,"mime"?: string,"object_path"?: string,"removed_at"?: string | null,"removed_by"?: string | null,"removed_reason"?: string | null,"request_id"?: string,"row_version"?: number,"sha256"?: string,"size_bytes"?: number,"status"?: string,"stored_at"?: string | null,"traveller_id"?: string,"traveller_seq"?: number,"updated_at"?: string,"uploaded_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "traveller_id_proofs_consent_by_fkey"
      columns: ["consent_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "traveller_id_proofs_legal_entity_id_deal_id_booking_versio_fkey"
      columns: ["legal_entity_id","deal_id","booking_version_id"]
isOneToOne: false
      referencedRelation: "booking_versions"
      referencedColumns: ["legal_entity_id","deal_id","id"]
    },{
      foreignKeyName: "traveller_id_proofs_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "traveller_id_proofs_removed_by_fkey"
      columns: ["removed_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "traveller_id_proofs_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"traveller_identities": {
                  Row: {
                    "created_at": string,"date_of_birth": string | null,"date_of_marriage": string | null,"deal_id": string,"email": string | null,"extra_phones": (string)[],"legal_entity_id": string,"nationality": string | null,"passport_expiry": string | null,"passport_number": string | null,"phone": string | null,"row_version": number,"traveller_id": string,"updated_at": string,"updated_by": string
                  }
                  Insert: {
                    "created_at"?: string,"date_of_birth"?: string | null,"date_of_marriage"?: string | null,"deal_id": string,"email"?: string | null,"extra_phones"?: (string)[],"legal_entity_id": string,"nationality"?: string | null,"passport_expiry"?: string | null,"passport_number"?: string | null,"phone"?: string | null,"row_version"?: number,"traveller_id": string,"updated_at"?: string,"updated_by": string
                  }
                  Update: {
                    "created_at"?: string,"date_of_birth"?: string | null,"date_of_marriage"?: string | null,"deal_id"?: string,"email"?: string | null,"extra_phones"?: (string)[],"legal_entity_id"?: string,"nationality"?: string | null,"passport_expiry"?: string | null,"passport_number"?: string | null,"phone"?: string | null,"row_version"?: number,"traveller_id"?: string,"updated_at"?: string,"updated_by"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "traveller_identities_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "traveller_identities_traveller_id_fkey"
      columns: ["traveller_id"]
isOneToOne: true
      referencedRelation: "deal_travellers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "traveller_identities_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"visa_applications": {
                  Row: {
                    "appointment_at": string | null,"appointment_place": string | null,"created_at": string,"customer_informed_at": string | null,"deal_id": string,"documents": NonNullable<Json>,"documents_returned_at": string | null,"documents_returned_by": string | null,"id": string,"legal_entity_id": string,"outcome_at": string | null,"outcome_evidence_id": string | null,"reference": string | null,"row_version": number,"service_item_id": string,"state": string,"submitted_at": string | null,"task_id": string,"traveller_seq": number,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "appointment_at"?: string | null,"appointment_place"?: string | null,"created_at"?: string,"customer_informed_at"?: string | null,"deal_id": string,"documents"?: NonNullable<Json>,"documents_returned_at"?: string | null,"documents_returned_by"?: string | null,"id"?: string,"legal_entity_id": string,"outcome_at"?: string | null,"outcome_evidence_id"?: string | null,"reference"?: string | null,"row_version"?: number,"service_item_id": string,"state"?: string,"submitted_at"?: string | null,"task_id": string,"traveller_seq": number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "appointment_at"?: string | null,"appointment_place"?: string | null,"created_at"?: string,"customer_informed_at"?: string | null,"deal_id"?: string,"documents"?: NonNullable<Json>,"documents_returned_at"?: string | null,"documents_returned_by"?: string | null,"id"?: string,"legal_entity_id"?: string,"outcome_at"?: string | null,"outcome_evidence_id"?: string | null,"reference"?: string | null,"row_version"?: number,"service_item_id"?: string,"state"?: string,"submitted_at"?: string | null,"task_id"?: string,"traveller_seq"?: number,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "visa_applications_documents_returned_by_fkey"
      columns: ["documents_returned_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    },{
      foreignKeyName: "visa_applications_legal_entity_id_deal_id_fkey"
      columns: ["legal_entity_id","deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "visa_applications_legal_entity_id_service_item_id_fkey"
      columns: ["legal_entity_id","service_item_id"]
isOneToOne: false
      referencedRelation: "service_items"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "visa_applications_legal_entity_id_task_id_fkey"
      columns: ["legal_entity_id","task_id"]
isOneToOne: false
      referencedRelation: "fulfilment_tasks"
      referencedColumns: ["legal_entity_id","id"]
    },{
      foreignKeyName: "visa_applications_outcome_evidence_id_fkey"
      columns: ["outcome_evidence_id"]
isOneToOne: false
      referencedRelation: "department_evidence"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "visa_applications_updated_by_fkey"
      columns: ["updated_by"]
isOneToOne: false
      referencedRelation: "staff_profiles"
      referencedColumns: ["user_id"]
    }
                  ]
                },"workflow_settings": {
                  Row: {
                    "id": boolean,"intake_prompt_enabled": boolean,"prefill_auto_fill": boolean,"referral_auto_close_resumed_at": string | null,"referral_drafts": boolean,"service_items_enabled": boolean,"updated_at": string,"visa_passport_tasks_enabled": boolean
                  }
                  Insert: {
                    "id"?: boolean,"intake_prompt_enabled"?: boolean,"prefill_auto_fill"?: boolean,"referral_auto_close_resumed_at"?: string | null,"referral_drafts"?: boolean,"service_items_enabled"?: boolean,"updated_at"?: string,"visa_passport_tasks_enabled"?: boolean
                  }
                  Update: {
                    "id"?: boolean,"intake_prompt_enabled"?: boolean,"prefill_auto_fill"?: boolean,"referral_auto_close_resumed_at"?: string | null,"referral_drafts"?: boolean,"service_items_enabled"?: boolean,"updated_at"?: string,"visa_passport_tasks_enabled"?: boolean
                  }
                  Relationships: [

                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_my_invitation":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"accounts_billing_save":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"accounts_billing_verify":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_request_id": string }; Returns: Json
                           },
"accounts_cash_overview":
{ Args: { "p_entity_id": string }; Returns: Json
                           },
"accounts_deal_detail":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"accounts_deal_lookup":
{ Args: { "p_reference": string }; Returns: Json
                           },
"accounts_expense_records":
{ Args: { "p_after"?: string,"p_filter": string,"p_limit"?: number }; Returns: Json
                           },
"accounts_payment_claims":
{ Args: { "p_after"?: string,"p_filter": string,"p_limit"?: number }; Returns: Json
                           },
"accounts_queue":
{ Args: { "p_after"?: string,"p_filter": string,"p_limit"?: number }; Returns: Json
                           },
"accounts_review_approve":
{ Args: { "p_booking_version_id": string,"p_expected_row_version": number,"p_request_id": string }; Returns: Json
                           },
"accounts_review_return":
{ Args: { "p_booking_version_id": string,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"admin_set_booking_live":
{ Args: { "p_enabled": boolean,"p_reason": string }; Returns: Json
                           },
"admin_set_finance_live_modes":
{ Args: { "p_entity": string,"p_modes": Json,"p_reason": string }; Returns: Json
                           },
"admin_set_supplier_confirmation_live":
{ Args: { "p_enabled": boolean,"p_reason": string }; Returns: Json
                           },
"admin_set_workflow_setting":
{ Args: { "p_key": string,"p_reason": string,"p_value": boolean }; Returns: Json
                           },
"begin_mfa_recovery":
{ Args: { "p_reason": string,"p_user_id": string }; Returns: Json
                           },
"bitrix_destination_options":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"bitrix_destination_scope_set":
{ Args: { "p_expected_row_version": number,"p_list_id": string,"p_option_id": string,"p_reason": string,"p_scope": string }; Returns: Json
                           },
"bitrix_id_proof_copy_alerts":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"bitrix_id_proof_copy_claim":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Json
                           },
"bitrix_id_proof_copy_complete":
{ Args: { "p_bitrix_file_id": number,"p_error_code": string,"p_job_id": string,"p_lease_token": string,"p_outcome": string }; Returns: Json
                           },
"bitrix_id_proof_copy_mark_sending":
{ Args: { "p_job_id": string,"p_lease_token": string,"p_prior_file_ids": (number)[] }; Returns: Json
                           },
"bitrix_id_proof_copy_retry":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"bitrix_id_proof_copy_status":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"bitrix_id_proof_copy_stop":
{ Args: { "p_job_id": string,"p_lease_token": string,"p_reason_code": string }; Returns: Json
                           },
"bitrix_name_map":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"bitrix_name_read_state":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"bitrix_trip_details_read_state":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"booking_authorize_evidence_download":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"booking_begin_evidence":
{ Args: { "p_file_name": string,"p_kind": string,"p_mime": string,"p_sha256": string,"p_size_bytes": number,"p_version_id": string }; Returns: Json
                           },
"booking_bill_to_select_party":
{ Args: { "p_billing_expected_row_version": number,"p_expected_row_version": number,"p_party_id": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"booking_billing_propose":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"booking_classify_revision":
{ Args: { "p_change_class": string,"p_expected_row_version": number,"p_version_id": string }; Returns: Json
                           },
"booking_commercials_save":
{ Args: { "p_discount_paise": number,"p_expected_row_version": number,"p_list_paise": number,"p_total_paise": number,"p_version_id": string }; Returns: Json
                           },
"booking_confirm":
{ Args: { "p_expected_content_hash": string,"p_version_id": string }; Returns: Json
                           },
"booking_contacts_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_version_id": string }; Returns: Json
                           },
"booking_customer_save":
{ Args: { "p_billing": Json,"p_billing_expected_row_version": number,"p_contact": Json,"p_expected_row_version": number,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"booking_discard_draft":
{ Args: { "p_expected_row_version": number,"p_version_id": string }; Returns: Json
                           },
"booking_finish_evidence":
{ Args: { "p_evidence_id": string,"p_ok": boolean }; Returns: Json
                           },
"booking_form_get":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_form_start":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_health":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"booking_instalments_save":
{ Args: { "p_expected_row_version": number,"p_instalments": Json,"p_version_id": string }; Returns: Json
                           },
"booking_open_draft":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_open_revision":
{ Args: { "p_base_version_id": string }; Returns: Json
                           },
"booking_panel":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_prefill_apply":
{ Args: { "p_expected_row_version": number,"p_fields": (string)[],"p_version_id": string }; Returns: Json
                           },
"booking_prices_save":
{ Args: { "p_expected_row_version": number,"p_lines": Json,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"booking_readiness":
{ Args: { "p_version_id": string }; Returns: Json
                           },
"booking_remove_evidence":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"booking_save_draft":
{ Args: { "p_expected_row_version": number,"p_facts": Json,"p_selling_total_paise": number,"p_selling_total_provided": boolean,"p_version_id": string }; Returns: Json
                           },
"booking_service_save":
{ Args: { "p_estimate": Json,"p_expected_row_version": number,"p_facts": Json,"p_item_id": string,"p_participants": (number)[],"p_purchase_budget_paise": number,"p_request_id": string,"p_service_type": string,"p_version_id": string }; Returns: Json
                           },
"booking_start_draft":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_trip_facts":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"booking_trip_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_version_id": string }; Returns: Json
                           },
"booking_version_history":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"bootstrap_first_admin":
{ Args: { "p_branch_code": string,"p_display_name": string,"p_email": string,"p_operator": string,"p_user_id": string }; Returns: Json
                           },
"cash_deposit_record":
{ Args: { "p_bank_reference": string,"p_branch_id": string,"p_deposited_on": string,"p_evidence_id": string,"p_receipt_ids": (string)[],"p_request_id": string }; Returns: Json
                           },
"cash_deposit_reject":
{ Args: { "p_deposit_id": string,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"cash_deposit_verify":
{ Args: { "p_deposit_id": string,"p_request_id": string }; Returns: Json
                           },
"cash_reconciliation_record":
{ Args: { "p_branch_id": string,"p_business_date": string,"p_counted_paise": number,"p_note": string,"p_request_id": string }; Returns: Json
                           },
"cash_reconciliation_verify":
{ Args: { "p_reconciliation_id": string,"p_request_id": string }; Returns: Json
                           },
"cheque_clear":
{ Args: { "p_outcome_date": string,"p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"cheque_mark":
{ Args: { "p_kind": string,"p_note": string,"p_outcome_date": string,"p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"cheque_represent":
{ Args: { "p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"company_destination_approve":
{ Args: { "p_expected_row_version": number,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"company_destination_options":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"company_destination_retire":
{ Args: { "p_destination_id": string,"p_expected_row_version": number,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"company_destination_return":
{ Args: { "p_expected_row_version": number,"p_reason": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"company_destination_submit":
{ Args: { "p_destination_id": string,"p_entity_id": string,"p_expected_row_version": number,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"company_destination_version_detail":
{ Args: { "p_version_id": string }; Returns: Json
                           },
"company_destinations_list":
{ Args: { "p_entity_id": string }; Returns: Json
                           },
"confirm_mfa_recovery":
{ Args: { "p_case_id": string,"p_confirmation_code": string,"p_method": string,"p_note": string }; Returns: Json
                           },
"create_staff_invitation":
{ Args: { "p_branch_id": string,"p_display_name": string,"p_email": string,"p_role_code": string }; Returns: string
                           },
"crm_search":
{ Args: { "p_after"?: Json,"p_kind": string,"p_limit"?: number,"p_query": string }; Returns: Json
                           },
"customer_party_accounts_list":
{ Args: { "p_limit"?: number,"p_offset"?: number,"p_status"?: string }; Returns: Json
                           },
"customer_party_accounts_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_party_id": string,"p_reason": string }; Returns: Json
                           },
"customer_party_check":
{ Args: { "p_decision": string,"p_expected_row_version": number,"p_party_id": string,"p_reason": string }; Returns: Json
                           },
"customer_party_create":
{ Args: { "p_deal_id": string,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"customer_party_document_authorize_download":
{ Args: { "p_file_id": string }; Returns: Json
                           },
"customer_party_document_begin":
{ Args: { "p_consent": boolean,"p_file_name": string,"p_kind": string,"p_mime": string,"p_party_id": string,"p_request_id": string,"p_sha256": string,"p_size_bytes": number }; Returns: Json
                           },
"customer_party_document_finish":
{ Args: { "p_file_id": string,"p_ok": boolean }; Returns: Json
                           },
"customer_party_document_remove":
{ Args: { "p_expected_row_version": number,"p_file_id": string }; Returns: Json
                           },
"customer_party_get":
{ Args: { "p_party_id": string }; Returns: Json
                           },
"customer_party_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_party_id": string }; Returns: Json
                           },
"customer_party_search":
{ Args: { "p_deal_id"?: string,"p_limit"?: number,"p_offset"?: number,"p_query": string }; Returns: Json
                           },
"deactivate_staff_member":
{ Args: { "p_reason": string,"p_user_id": string }; Returns: undefined
                           },
"deal_documents_list":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"deal_payment_claims":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"deal_service_summary":
{ Args: { "p_deal_ids": (string)[] }; Returns: Json
                           },
"deal_services":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"deal_travellers_save":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_travellers": Json }; Returns: Json
                           },
"department_cost_save":
{ Args: { "p_entry_id": string,"p_expected_row_version": number,"p_fields": Json,"p_request_id": string,"p_task_id": string }; Returns: Json
                           },
"department_cost_submit":
{ Args: { "p_entry_id": string,"p_expected_row_version": number }; Returns: Json
                           },
"department_evidence_authorize_download":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"department_evidence_begin":
{ Args: { "p_application_id": string,"p_file_name": string,"p_kind": string,"p_mime": string,"p_sha256": string,"p_size_bytes": number,"p_task_id": string }; Returns: Json
                           },
"department_evidence_finish":
{ Args: { "p_evidence_id": string,"p_ok": boolean }; Returns: Json
                           },
"department_evidence_remove":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"department_task_history":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"department_work_form":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"expense_record_accept":
{ Args: { "p_entry_id": string,"p_expected_row_version": number,"p_request_id": string }; Returns: Json
                           },
"expense_record_return":
{ Args: { "p_entry_id": string,"p_expected_row_version": number,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"finance_enabled_entities":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"finance_evidence_authorize_download":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"finance_evidence_begin":
{ Args: { "p_file_name": string,"p_kind": string,"p_mime": string,"p_request_id": string,"p_sha256": string,"p_size_bytes": number,"p_target_id": string,"p_target_type": string }; Returns: Json
                           },
"finance_evidence_finish":
{ Args: { "p_evidence_id": string,"p_ok": boolean }; Returns: Json
                           },
"finance_evidence_remove":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"finance_policy_get":
{ Args: { "p_entity_id": string }; Returns: Json
                           },
"finance_policy_update":
{ Args: { "p_effective_at": string,"p_entity_id": string,"p_fields": Json,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"flight_task_claim":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"flight_task_get":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"flight_task_list":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_mfa_recovery_cleanup":
{ Args: { "p_case_id": string }; Returns: Json
                           },
"get_mfa_recovery_deletion_plan":
{ Args: { "p_case_id": string,"p_phase": string }; Returns: Json
                           },
"grant_access_scope":
{ Args: { "p_branch_id": string,"p_expires_at"?: string,"p_legal_entity_id": string,"p_permission": string,"p_reason": string,"p_user_id": string }; Returns: string
                           },
"hotel_catalogue_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_id": string,"p_legal_entity_id": string,"p_reason": string }; Returns: Json
                           },
"hotel_catalogue_search":
{ Args: { "p_city"?: string,"p_limit"?: number,"p_offset"?: number,"p_query": string }; Returns: Json
                           },
"import_batch_apply":
{ Args: { "p_batch_id": string,"p_expected_row_version": number,"p_proposal_hash"?: string,"p_reason": string }; Returns: Json
                           },
"import_batch_cancel":
{ Args: { "p_batch_id": string,"p_expected_row_version": number }; Returns: Json
                           },
"import_batch_get":
{ Args: { "p_batch_id": string,"p_limit"?: number,"p_offset"?: number }; Returns: Json
                           },
"import_batch_list":
{ Args: { "p_kind": string,"p_limit"?: number }; Returns: Json
                           },
"import_batch_stage":
{ Args: { "p_branch_id": string,"p_entity_wide"?: boolean,"p_file_name": string,"p_kind": string,"p_legal_entity_id": string,"p_request_id": string,"p_rows": Json,"p_sha256": string }; Returns: Json
                           },
"import_batch_validate":
{ Args: { "p_batch_id": string }; Returns: Json
                           },
"intake_checklist":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"intake_scope_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"integration_active_manifest":
{ Args: { "p_member_id": string,"p_source_object": string }; Returns: Json
                           },
"integration_apply_bitrix_deal":
{ Args: { "p_deal": Json,"p_inbox_id": string,"p_lock_token": string }; Returns: Json
                           },
"integration_apply_bitrix_lead":
{ Args: { "p_inbox_id": string,"p_lead": Json,"p_lock_token": string }; Returns: Json
                           },
"integration_apply_bitrix_names":
{ Args: { "p_complete": boolean,"p_lists": Json,"p_portal": string }; Returns: Json
                           },
"integration_apply_bitrix_party":
{ Args: { "p_inbox_id": string,"p_party": Json }; Returns: Json
                           },
"integration_apply_bitrix_trip_facts":
{ Args: { "p_facts": Json,"p_inbox_id": string }; Returns: Json
                           },
"integration_apply_sync_settings":
{ Args: { "p_preview_id": string,"p_reason": string }; Returns: Json
                           },
"integration_auto_sync_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"integration_bitrix_names_due":
{ Args: { "p_portal": string }; Returns: Json
                           },
"integration_claim_inbox":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Json[]
                           },
"integration_enqueue_reconcile":
{ Args: { "p_deal_id": number,"p_member_id": string,"p_source_modified": number }; Returns: Json
                           },
"integration_enqueue_reconcile_lead":
{ Args: { "p_lead_id": number,"p_member_id": string,"p_source_modified": number }; Returns: Json
                           },
"integration_fail_inbox":
{ Args: { "p_error_code": string,"p_inbox_id": string,"p_lock_token": string,"p_retryable": boolean }; Returns: Json
                           },
"integration_inbox_row_status":
{ Args: { "p_inbox_id": string }; Returns: Json
                           },
"integration_link_bitrix_user":
{ Args: { "p_bitrix_user_id": number,"p_staff_user_id": string }; Returns: Json
                           },
"integration_manifest_close":
{ Args: { "p_manifest_id": string,"p_operator": string }; Returns: Json
                           },
"integration_manifest_create":
{ Args: { "p_business_date": string,"p_config_id": string,"p_ids": (number)[],"p_interval_from": string,"p_interval_to": string,"p_operator": string,"p_source_code": string,"p_source_object": string }; Returns: Json
                           },
"integration_preview_sync_settings":
{ Args: { "p_category_ids": (number)[],"p_cutoff_at": string,"p_deal_intake_mode"?: string,"p_lead_intake_mode"?: string,"p_stage_ids": (string)[],"p_sync_enabled": boolean }; Returns: Json
                           },
"integration_prune_deals_outside_entry_stages":
{ Args: { "p_dry_run": boolean,"p_reason": string }; Returns: Json
                           },
"integration_queue_resync":
{ Args: { "p_member_id": string }; Returns: Json
                           },
"integration_receive_bitrix_event":
{ Args: { "p_credential": string,"p_deal_id": number,"p_domain": string,"p_event_type": string,"p_member_id": string,"p_source_ts": number }; Returns: Json
                           },
"integration_record_bitrix_event":
{ Args: { "p_deal_id": number,"p_event_type": string,"p_member_id": string,"p_source_ts": number }; Returns: Json
                           },
"integration_record_lead_reconcile_run":
{ Args: { "p_member_id": string,"p_ok": boolean,"p_started_at": string }; Returns: Json
                           },
"integration_record_reconcile_run":
{ Args: { "p_member_id": string,"p_ok": boolean,"p_started_at": string }; Returns: Json
                           },
"integration_record_worker_run":
{ Args: { "p_run": Json }; Returns: Json
                           },
"integration_release_inbox":
{ Args: { "p_inbox_id": string,"p_lock_token": string }; Returns: Json
                           },
"integration_request_reconcile":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"integration_resync_finish":
{ Args: { "p_job": string,"p_token": string }; Returns: Json
                           },
"integration_resync_next":
{ Args: { "p_lease_seconds": number,"p_member_id": string }; Returns: Json
                           },
"integration_resync_page":
{ Args: { "p_deals": Json,"p_job": string,"p_last": boolean,"p_token": string,"p_total": number }; Returns: Json
                           },
"integration_resync_release":
{ Args: { "p_job": string,"p_token": string }; Returns: undefined
                           },
"integration_retry_inbox":
{ Args: { "p_inbox_id": string }; Returns: Json
                           },
"integration_set_bitrix_id_proof_copy":
{ Args: { "p_on": boolean,"p_reason": string }; Returns: Json
                           },
"integration_set_bitrix_name_read":
{ Args: { "p_enabled": boolean,"p_reason": string }; Returns: Json
                           },
"integration_set_bitrix_read_switches":
{ Args: { "p_lead_intake_unowned": boolean,"p_reason": string,"p_trip_facts_read": boolean }; Returns: Json
                           },
"integration_set_bitrix_trip_details_read":
{ Args: { "p_enabled": boolean,"p_reason": string }; Returns: Json
                           },
"integration_set_deal_entry_stages":
{ Args: { "p_reason": string,"p_stage_ids": (string)[] }; Returns: Json
                           },
"integration_sync_alert_check":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"integration_sync_alert_mark_sent":
{ Args: { "p_incident": string,"p_kind": string }; Returns: undefined
                           },
"integration_unlink_bitrix_user":
{ Args: { "p_staff_user_id": string }; Returns: Json
                           },
"integration_update_sync_settings":
{ Args: { "p_category_ids": (number)[],"p_cutoff_at": string,"p_deal_intake_mode"?: string,"p_lead_intake_mode"?: string,"p_stage_ids": (string)[],"p_sync_enabled": boolean }; Returns: Json
                           },
"integration_waiting_for_owner":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"itinerary_create_standalone":
{ Args: { "p_branch_id": string,"p_customer": Json,"p_request_id": string,"p_title": string }; Returns: Json
                           },
"itinerary_difference_acknowledge":
{ Args: { "p_difference_id": string,"p_note": string }; Returns: Json
                           },
"itinerary_differences_save":
{ Args: { "p_basis_hash": string,"p_basis_id": string,"p_basis_kind": string,"p_differences": Json,"p_draft_id": string,"p_expected_row_version": number }; Returns: Json
                           },
"itinerary_document_create":
{ Args: { "p_request_id": string,"p_subject_id": string,"p_subject_kind": string,"p_title": string }; Returns: Json
                           },
"itinerary_document_get":
{ Args: { "p_document_id": string }; Returns: Json
                           },
"itinerary_document_list":
{ Args: { "p_subject_id": string,"p_subject_kind": string }; Returns: Json
                           },
"itinerary_facts_mark_ready":
{ Args: { "p_draft_id": string,"p_expected_row_version": number }; Returns: Json
                           },
"itinerary_facts_save":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_facts": Json,"p_source_file_id": string }; Returns: Json
                           },
"itinerary_render_claim":
{ Args: { "p_lease_seconds": number,"p_worker": string }; Returns: Json
                           },
"itinerary_render_complete":
{ Args: { "p_error_code": string,"p_file": Json,"p_job_id": string,"p_ok": boolean,"p_worker": string }; Returns: Json
                           },
"itinerary_render_input":
{ Args: { "p_job_id": string,"p_worker": string }; Returns: Json
                           },
"itinerary_render_request":
{ Args: { "p_document_id": string,"p_input_hash": string,"p_kind": string,"p_template_version": string }; Returns: Json
                           },
"itinerary_rendered_authorize_download":
{ Args: { "p_rendered_id": string }; Returns: Json
                           },
"itinerary_source_authorize_download":
{ Args: { "p_file_id": string }; Returns: Json
                           },
"itinerary_source_begin":
{ Args: { "p_document_id": string,"p_file_name": string,"p_mime": string,"p_sha256": string,"p_size_bytes": number }; Returns: Json
                           },
"itinerary_source_finish":
{ Args: { "p_file_id": string,"p_ok": boolean }; Returns: Json
                           },
"itinerary_source_remove":
{ Args: { "p_file_id": string }; Returns: Json
                           },
"link_invitation_user":
{ Args: { "p_invitation_id": string,"p_user_id": string }; Returns: undefined
                           },
"my_session_status":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_work_counts":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"my_work_list":
{ Args: { "p_after": Json,"p_kind": string,"p_limit": number }; Returns: Json
                           },
"payment_claim_link_receipt":
{ Args: { "p_claim_id": string,"p_reason": string,"p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"payment_claim_mark_not_received":
{ Args: { "p_claim_id": string,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"payment_claim_report":
{ Args: { "p_deal_id": string,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"payment_claim_withdraw":
{ Args: { "p_claim_id": string,"p_expected_row_version": number,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"prefill_fill_empty":
{ Args: { "p_expected_row_version": number,"p_target_id": string,"p_target_kind": string }; Returns: Json
                           },
"prefill_mark_checked":
{ Args: { "p_expected_row_version": number,"p_fields": (string)[],"p_target_id": string,"p_target_kind": string }; Returns: Json
                           },
"prefill_notice_dismiss":
{ Args: { "p_expected_row_version": number,"p_field": string,"p_source_modified_at": string,"p_target_id": string,"p_target_kind": string }; Returns: Json
                           },
"purchase_cost_approve_over_budget":
{ Args: { "p_task_id": string,"p_version_no": number }; Returns: Json
                           },
"purchase_cost_propose":
{ Args: { "p_amount_paise": number,"p_due_date": string,"p_expected_version_no": number,"p_note": string,"p_quote_id": string,"p_request_id": string,"p_task_id": string }; Returns: Json
                           },
"purchase_evidence_authorize_download":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"purchase_evidence_begin":
{ Args: { "p_file_name": string,"p_kind": string,"p_mime": string,"p_sha256": string,"p_size_bytes": number,"p_task_id": string }; Returns: Json
                           },
"purchase_evidence_finish":
{ Args: { "p_evidence_id": string,"p_ok": boolean }; Returns: Json
                           },
"purchase_evidence_remove":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"purchase_quote_add":
{ Args: { "p_fields": Json,"p_request_id": string,"p_task_id": string }; Returns: Json
                           },
"purchase_quote_withdraw":
{ Args: { "p_quote_id": string }; Returns: Json
                           },
"purchase_supplier_confirm":
{ Args: { "p_expected_version_no": number,"p_reference": string,"p_task_id": string }; Returns: Json
                           },
"purchase_task_claim":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"purchase_task_get":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"purchase_task_list":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"purchase_task_reassign":
{ Args: { "p_expected_assignee": string,"p_task_id": string,"p_to_user_id": string }; Returns: Json
                           },
"purchase_task_release":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"purchase_workspace":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"quotation_accept":
{ Args: { "p_evidence_id": string,"p_expected_content_hash": string,"p_request_id": string,"p_tier_key": string,"p_version_id": string }; Returns: Json
                           },
"quotation_contacts_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_version_id": string }; Returns: Json
                           },
"quotation_convert_to_booking":
{ Args: { "p_expected_content_hash": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"quotation_cost_estimates_save":
{ Args: { "p_costs": Json,"p_version_id": string }; Returns: Json
                           },
"quotation_create":
{ Args: { "p_request_id": string,"p_subject_id": string,"p_subject_kind": string,"p_title": string }; Returns: Json
                           },
"quotation_create_standalone":
{ Args: { "p_branch_id": string,"p_customer": Json,"p_request_id": string,"p_title": string }; Returns: Json
                           },
"quotation_customer_money":
{ Args: { "p_version_id": string }; Returns: Json
                           },
"quotation_decline":
{ Args: { "p_expected_row_version": number,"p_reason": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"quotation_discard":
{ Args: { "p_expected_row_version": number,"p_version_id": string }; Returns: Json
                           },
"quotation_evidence_authorize_download":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"quotation_evidence_begin":
{ Args: { "p_file_name": string,"p_kind": string,"p_mime": string,"p_sha256": string,"p_size_bytes": number,"p_version_id": string }; Returns: Json
                           },
"quotation_evidence_finish":
{ Args: { "p_evidence_id": string,"p_ok": boolean }; Returns: Json
                           },
"quotation_evidence_remove":
{ Args: { "p_evidence_id": string }; Returns: Json
                           },
"quotation_get":
{ Args: { "p_version_id": string }; Returns: Json
                           },
"quotation_item_add":
{ Args: { "p_expected_row_version": number,"p_facts": Json,"p_service_type": string,"p_tier_key": string,"p_version_id": string }; Returns: Json
                           },
"quotation_item_remove":
{ Args: { "p_expected_row_version": number,"p_item_id": string,"p_version_id": string }; Returns: Json
                           },
"quotation_item_save":
{ Args: { "p_expected_row_version": number,"p_facts": Json,"p_item_id": string,"p_tier_key": string,"p_version_id": string }; Returns: Json
                           },
"quotation_lines_save":
{ Args: { "p_expected_row_version": number,"p_lines": Json,"p_version_id": string }; Returns: Json
                           },
"quotation_link_candidates":
{ Args: { "p_quotation_id": string }; Returns: Json
                           },
"quotation_link_deal":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_quotation_id": string }; Returns: Json
                           },
"quotation_list":
{ Args: { "p_subject_id": string,"p_subject_kind": string }; Returns: Json
                           },
"quotation_mark_ready":
{ Args: { "p_expected_row_version": number,"p_version_id": string }; Returns: Json
                           },
"quotation_mark_sent":
{ Args: { "p_channel": string,"p_expected_content_hash": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"quotation_new_version":
{ Args: { "p_base_version_id": string,"p_quotation_id": string,"p_request_id": string }; Returns: Json
                           },
"quotation_plan_save":
{ Args: { "p_expected_row_version": number,"p_instalments": Json,"p_tier_key": string,"p_version_id": string }; Returns: Json
                           },
"quotation_prefill_apply":
{ Args: { "p_expected_row_version": number,"p_fields": (string)[],"p_version_id": string }; Returns: Json
                           },
"quotation_tiers_save":
{ Args: { "p_expected_row_version": number,"p_tiers": Json,"p_version_id": string }; Returns: Json
                           },
"quotation_total_save":
{ Args: { "p_expected_row_version": number,"p_show_per_person": boolean,"p_tier_key": string,"p_total_paise": number,"p_version_id": string }; Returns: Json
                           },
"quotation_version_save":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_version_id": string }; Returns: Json
                           },
"receipt_record":
{ Args: { "p_deal_id": string,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"receipt_record_from_claim":
{ Args: { "p_claim_id": string,"p_fields": Json,"p_request_id": string }; Returns: Json
                           },
"receipt_reject":
{ Args: { "p_kind": string,"p_reason": string,"p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"receipt_reverse":
{ Args: { "p_kind": string,"p_reason": string,"p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"receipt_verify":
{ Args: { "p_receipt_id": string,"p_request_id": string }; Returns: Json
                           },
"record_mfa_recovery_cleanup_result":
{ Args: { "p_case_id": string,"p_error_code": string,"p_ok": boolean }; Returns: Json
                           },
"record_mfa_recovery_provider_result":
{ Args: { "p_case_id": string,"p_error_code": string,"p_ok": boolean }; Returns: Json
                           },
"record_staff_email_result":
{ Args: { "p_delivery_id": string,"p_error_code": string,"p_ok": boolean }; Returns: Json
                           },
"record_staff_names":
{ Args: { "p_user_ids": (string)[] }; Returns: Json
                           },
"referral_draft_close":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_note": string,"p_reason": string }; Returns: Json
                           },
"referral_draft_find":
{ Args: { "p_reference": string }; Returns: Json
                           },
"referral_draft_get":
{ Args: { "p_draft_id": string }; Returns: Json
                           },
"referral_draft_link":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_note": string,"p_target_id": string,"p_target_kind": string }; Returns: Json
                           },
"referral_draft_reassign":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_new_owner": string,"p_reason": string }; Returns: Json
                           },
"referral_draft_reopen":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_note": string }; Returns: Json
                           },
"referral_draft_save":
{ Args: { "p_draft_id": string,"p_expected_row_version": number,"p_fields": Json }; Returns: Json
                           },
"referral_draft_unlink":
{ Args: { "p_expected_row_version": number,"p_link_id": string,"p_note": string,"p_reason": string }; Returns: Json
                           },
"referral_drafts_close_inactive":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"referral_drafts_for_subject":
{ Args: { "p_subject_id": string,"p_subject_kind": string }; Returns: Json
                           },
"referral_link_candidates":
{ Args: { "p_draft_id": string,"p_kind": string,"p_query": string }; Returns: Json
                           },
"referral_owner_candidates":
{ Args: { "p_draft_id": string }; Returns: Json
                           },
"register_my_recovery_factor":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"request_invitation_email":
{ Args: { "p_invitation_id": string }; Returns: Json
                           },
"request_staff_email":
{ Args: { "p_kind": string,"p_user_id": string }; Returns: Json
                           },
"resume_mfa_recovery_provider":
{ Args: { "p_case_id": string }; Returns: Json
                           },
"retry_mfa_recovery_cleanup":
{ Args: { "p_case_id": string }; Returns: Json
                           },
"revoke_access_grant":
{ Args: { "p_grant_id": string,"p_reason": string }; Returns: undefined
                           },
"revoke_my_sessions":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"service_item_add":
{ Args: { "p_expected_row_version": number,"p_facts": Json,"p_purchase_budget_paise": number,"p_request_id": string,"p_service_type": string,"p_version_id": string }; Returns: Json
                           },
"service_item_file_authorize_download":
{ Args: { "p_file_id": string }; Returns: Json
                           },
"service_item_file_begin":
{ Args: { "p_file": Json,"p_item_id": string,"p_kind": string,"p_request_id": string,"p_version_id": string }; Returns: Json
                           },
"service_item_file_finish":
{ Args: { "p_file_id": string,"p_ok": boolean }; Returns: Json
                           },
"service_item_file_remove":
{ Args: { "p_expected_row_version": number,"p_file_id": string }; Returns: Json
                           },
"service_item_remove":
{ Args: { "p_expected_row_version": number,"p_item_id": string,"p_version_id": string }; Returns: Json
                           },
"service_item_save":
{ Args: { "p_expected_row_version": number,"p_facts": Json,"p_item_id": string,"p_purchase_budget_paise": number,"p_version_id": string }; Returns: Json
                           },
"service_item_travellers_save":
{ Args: { "p_expected_row_version": number,"p_item_id": string,"p_seqs": (number)[],"p_version_id": string }; Returns: Json
                           },
"settings_switch_states":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"supplier_add_beneficiary":
{ Args: { "p_fields": Json,"p_request_id": string,"p_supplier_id": string }; Returns: Json
                           },
"supplier_approve_beneficiary":
{ Args: { "p_revision_no": number,"p_supplier_id": string }; Returns: Json
                           },
"supplier_create":
{ Args: { "p_entity_id": string,"p_fields": Json }; Returns: Json
                           },
"supplier_get":
{ Args: { "p_supplier_id": string }; Returns: Json
                           },
"supplier_list":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"supplier_update":
{ Args: { "p_expected_row_version": number,"p_fields": Json,"p_supplier_id": string }; Returns: Json
                           },
"supplier_verify":
{ Args: { "p_expected_row_version": number,"p_supplier_id": string }; Returns: Json
                           },
"traveller_id_proof_authorize_download":
{ Args: { "p_file_id": string }; Returns: Json
                           },
"traveller_id_proof_begin":
{ Args: { "p_consent": boolean,"p_deal_id": string,"p_file_name": string,"p_mime": string,"p_request_id": string,"p_seq": number,"p_sha256": string,"p_size_bytes": number }; Returns: Json
                           },
"traveller_id_proof_finish":
{ Args: { "p_file_id": string,"p_ok": boolean }; Returns: Json
                           },
"traveller_id_proof_remove":
{ Args: { "p_expected_row_version": number,"p_file_id": string }; Returns: Json
                           },
"traveller_id_proofs_for_deal":
{ Args: { "p_deal_id": string }; Returns: Json
                           },
"traveller_id_proofs_for_task":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"traveller_identity_save":
{ Args: { "p_deal_id": string,"p_expected_row_version": number,"p_fields": Json,"p_seq": number }; Returns: Json
                           },
"visa_application_set_state":
{ Args: { "p_application_id": string,"p_evidence_id": string,"p_expected_row_version": number,"p_state": string }; Returns: Json
                           },
"visa_application_update":
{ Args: { "p_application_id": string,"p_expected_row_version": number,"p_fields": Json }; Returns: Json
                           },
"visa_task_claim":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"visa_task_get":
{ Args: { "p_task_id": string }; Returns: Json
                           },
"visa_task_list":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"work_drafts_list":
{ Args: { "p_after": Json,"p_filter": Json,"p_kind": string,"p_limit": number }; Returns: Json
                           },
"workflow_settings_get":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"workflow_visa_task_preview":
{ Args: Record<PropertyKey, never>; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {

          }
        }
} as const
