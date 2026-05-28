/**
 * Hardcoded tool schemas for Gemini function declarations.
 *
 * These are used when the MCP server is not available. They provide
 * the same tool names, descriptions, and parameter definitions that
 * the MCP server would return via tools/list.
 *
 * This eliminates the MCP server dependency for production deployment.
 * The MCP server is only needed during development for schema discovery.
 *
 * @module tool-schemas
 */

export interface HardcodedToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>;
    required: string[];
  };
}

/**
 * All 46 tool schemas matching the EspoCRM MCP server's tools/list output.
 */
export const HARDCODED_TOOL_SCHEMAS: HardcodedToolSchema[] = [
  // ── Contacts ──────────────────────────────────────────
  {
    name: 'create_contact',
    description: 'Create a new contact in EspoCRM',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: "Contact's first name" },
        lastName: { type: 'string', description: "Contact's last name" },
        emailAddress: { type: 'string', description: "Contact's email address" },
        phoneNumber: { type: 'string', description: "Contact's phone number" },
        title: { type: 'string', description: 'Job title or position' },
        accountId: { type: 'string', description: 'ID of the account this contact belongs to' },
        department: { type: 'string', description: 'Department within the organization' },
        description: { type: 'string', description: 'Additional notes about the contact' },
      },
      required: ['firstName', 'lastName'],
    },
  },
  {
    name: 'search_contacts',
    description: 'Search for contacts using flexible criteria',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string', description: 'Search in first name, last name, and email' },
        emailAddress: { type: 'string', description: 'Filter by email address' },
        phoneNumber: { type: 'string', description: 'Filter by phone number' },
        accountName: { type: 'string', description: 'Filter by account/company name' },
        limit: { type: 'number', description: 'Maximum number of results (default 20)' },
        offset: { type: 'number', description: 'Number of records to skip' },
      },
      required: [],
    },
  },
  {
    name: 'get_contact',
    description: 'Get detailed information about a specific contact by ID',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'The unique ID of the contact' },
      },
      required: ['contactId'],
    },
  },

  // ── Accounts ──────────────────────────────────────────
  {
    name: 'create_account',
    description: 'Create a new account/company in EspoCRM',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company or organization name' },
        emailAddress: { type: 'string', description: 'Main company email' },
        phoneNumber: { type: 'string', description: 'Main company phone' },
        website: { type: 'string', description: 'Company website URL' },
        type: { type: 'string', description: 'Type of business relationship', enum: ['Customer', 'Investor', 'Partner', 'Reseller'] },
        industry: { type: 'string', description: 'Industry or business sector' },
        description: { type: 'string', description: 'Additional information' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_accounts',
    description: 'Search for accounts/companies using flexible criteria',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Search by company name' },
        type: { type: 'string', description: 'Filter by account type', enum: ['Customer', 'Investor', 'Partner', 'Reseller'] },
        industry: { type: 'string', description: 'Filter by industry' },
        limit: { type: 'number', description: 'Maximum results (default 20)' },
        offset: { type: 'number', description: 'Records to skip' },
      },
      required: [],
    },
  },

  // ── Opportunities ─────────────────────────────────────
  {
    name: 'create_opportunity',
    description: 'Create a new sales opportunity in EspoCRM',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Opportunity name/title' },
        accountId: { type: 'string', description: 'ID of the account' },
        stage: { type: 'string', description: 'Current sales stage', enum: ['Prospecting', 'Qualification', 'Needs Analysis', 'Value Proposition', 'Id. Decision Makers', 'Perception Analysis', 'Proposal/Price Quote', 'Closed Won', 'Closed Lost'] },
        closeDate: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
        amount: { type: 'number', description: 'Expected revenue amount' },
        probability: { type: 'number', description: 'Probability of closing (0-100)' },
        description: { type: 'string', description: 'Additional details' },
      },
      required: ['name', 'accountId', 'stage', 'closeDate'],
    },
  },
  {
    name: 'search_opportunities',
    description: 'Search for sales opportunities',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Search by opportunity name' },
        accountName: { type: 'string', description: 'Filter by account name' },
        stage: { type: 'string', description: 'Filter by sales stage', enum: ['Prospecting', 'Qualification', 'Needs Analysis', 'Value Proposition', 'Id. Decision Makers', 'Perception Analysis', 'Proposal/Price Quote', 'Closed Won', 'Closed Lost'] },
        minAmount: { type: 'number', description: 'Minimum opportunity value' },
        maxAmount: { type: 'number', description: 'Maximum opportunity value' },
        limit: { type: 'number', description: 'Maximum results' },
        offset: { type: 'number', description: 'Records to skip' },
      },
      required: [],
    },
  },

  // ── Leads ─────────────────────────────────────────────
  {
    name: 'create_lead',
    description: 'Create a new lead',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: "Lead's first name" },
        lastName: { type: 'string', description: "Lead's last name" },
        emailAddress: { type: 'string', description: "Lead's email" },
        phoneNumber: { type: 'string', description: "Lead's phone" },
        accountName: { type: 'string', description: 'Company name' },
        source: { type: 'string', description: 'Lead source', enum: ['Call', 'Email', 'Existing Customer', 'Partner', 'Public Relations', 'Web Site', 'Campaign', 'Other'] },
        status: { type: 'string', description: 'Lead status', enum: ['New', 'Assigned', 'In Process', 'Converted', 'Recycled', 'Dead'] },
        industry: { type: 'string', description: 'Industry' },
        description: { type: 'string', description: 'Additional info' },
        assignedUserId: { type: 'string', description: 'Assigned user ID' },
      },
      required: ['firstName', 'lastName', 'source'],
    },
  },
  {
    name: 'search_leads',
    description: 'Search for leads',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Search by name' },
        emailAddress: { type: 'string', description: 'Filter by email' },
        accountName: { type: 'string', description: 'Filter by company' },
        status: { type: 'string', description: 'Filter by status', enum: ['New', 'Assigned', 'In Process', 'Converted', 'Recycled', 'Dead'] },
        source: { type: 'string', description: 'Filter by source', enum: ['Call', 'Email', 'Existing Customer', 'Partner', 'Public Relations', 'Web Site', 'Campaign', 'Other'] },
        limit: { type: 'number', description: 'Maximum results' },
        offset: { type: 'number', description: 'Records to skip' },
      },
      required: [],
    },
  },
  {
    name: 'update_lead',
    description: 'Update an existing lead',
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'The lead ID to update' },
        firstName: { type: 'string' }, lastName: { type: 'string' },
        emailAddress: { type: 'string' }, phoneNumber: { type: 'string' },
        status: { type: 'string', enum: ['New', 'Assigned', 'In Process', 'Converted', 'Recycled', 'Dead'] },
        source: { type: 'string', enum: ['Call', 'Email', 'Existing Customer', 'Partner', 'Public Relations', 'Web Site', 'Campaign', 'Other'] },
        assignedUserId: { type: 'string' }, description: { type: 'string' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'convert_lead',
    description: 'Convert a lead to contact, account, and/or opportunity',
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'The lead ID to convert' },
        createContact: { type: 'boolean', description: 'Create a contact (default true)' },
        createAccount: { type: 'boolean', description: 'Create an account (default true)' },
        createOpportunity: { type: 'boolean', description: 'Create an opportunity (default false)' },
        opportunityName: { type: 'string' }, opportunityAmount: { type: 'number' },
      },
      required: ['leadId'],
    },
  },
  {
    name: 'assign_lead',
    description: 'Assign or reassign a lead to a user',
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'The lead ID' },
        assignedUserId: { type: 'string', description: 'User ID to assign to' },
      },
      required: ['leadId', 'assignedUserId'],
    },
  },

  // ── Meetings ──────────────────────────────────────────
  {
    name: 'create_meeting',
    description: 'Create a new meeting',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Meeting name/title' },
        dateStart: { type: 'string', description: 'Start date/time (ISO format)' },
        dateEnd: { type: 'string', description: 'End date/time (ISO format)' },
        description: { type: 'string' }, location: { type: 'string' },
        status: { type: 'string', enum: ['Planned', 'Held', 'Not Held'] },
      },
      required: ['name', 'dateStart', 'dateEnd'],
    },
  },
  {
    name: 'search_meetings',
    description: 'Search for meetings',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, dateFrom: { type: 'string' }, dateTo: { type: 'string' },
        status: { type: 'string', enum: ['Planned', 'Held', 'Not Held'] },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_meeting',
    description: 'Get meeting details by ID',
    inputSchema: { type: 'object', properties: { meetingId: { type: 'string' } }, required: ['meetingId'] },
  },
  {
    name: 'update_meeting',
    description: 'Update an existing meeting',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string' }, name: { type: 'string' },
        dateStart: { type: 'string' }, dateEnd: { type: 'string' },
        description: { type: 'string' }, location: { type: 'string' },
        status: { type: 'string', enum: ['Planned', 'Held', 'Not Held'] },
      },
      required: ['meetingId'],
    },
  },

  // ── Tasks ─────────────────────────────────────────────
  {
    name: 'create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, description: { type: 'string' },
        dateEnd: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        status: { type: 'string', enum: ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
        assignedUserId: { type: 'string' },
        parentType: { type: 'string', enum: ['Lead', 'Account', 'Contact', 'Opportunity'] },
        parentId: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_tasks',
    description: 'Search for tasks',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: { type: 'string', enum: ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
        assignedUserName: { type: 'string' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_task',
    description: 'Get task details by ID',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'update_task',
    description: 'Update an existing task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        dateEnd: { type: 'string' },
        status: { type: 'string', enum: ['Not Started', 'Started', 'Completed', 'Canceled', 'Deferred'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
        assignedUserId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'assign_task',
    description: 'Assign a task to a user',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, assignedUserId: { type: 'string' } },
      required: ['taskId', 'assignedUserId'],
    },
  },

  // ── Calls ─────────────────────────────────────────────
  {
    name: 'create_call',
    description: 'Log a phone call',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Call subject' },
        direction: { type: 'string', enum: ['Outbound', 'Inbound'] },
        dateStart: { type: 'string' }, dateEnd: { type: 'string' },
        description: { type: 'string' }, status: { type: 'string', enum: ['Planned', 'Held', 'Not Held'] },
      },
      required: ['name', 'direction'],
    },
  },
  {
    name: 'search_calls',
    description: 'Search for calls',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, direction: { type: 'string', enum: ['Outbound', 'Inbound'] },
        status: { type: 'string', enum: ['Planned', 'Held', 'Not Held'] },
        dateFrom: { type: 'string' }, dateTo: { type: 'string' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },

  // ── Cases ─────────────────────────────────────────────
  {
    name: 'create_case',
    description: 'Create a support case/ticket',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Case subject' },
        status: { type: 'string', enum: ['New', 'Assigned', 'Pending', 'Closed', 'Rejected', 'Duplicate'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
        type: { type: 'string', enum: ['Question', 'Incident', 'Problem', 'Feature Request'] },
        description: { type: 'string' }, accountId: { type: 'string' }, contactId: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'search_cases',
    description: 'Search for support cases',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: { type: 'string', enum: ['New', 'Assigned', 'Pending', 'Closed', 'Rejected', 'Duplicate'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'update_case',
    description: 'Update a support case',
    inputSchema: {
      type: 'object',
      properties: {
        caseId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
        status: { type: 'string', enum: ['New', 'Assigned', 'Pending', 'Closed', 'Rejected', 'Duplicate'] },
        priority: { type: 'string', enum: ['Low', 'Normal', 'High', 'Urgent'] },
      },
      required: ['caseId'],
    },
  },

  // ── Notes ─────────────────────────────────────────────
  {
    name: 'add_note',
    description: 'Add a note/comment to any entity',
    inputSchema: {
      type: 'object',
      properties: {
        post: { type: 'string', description: 'Note content' },
        parentType: { type: 'string', description: 'Entity type (Account, Contact, etc.)' },
        parentId: { type: 'string', description: 'Entity ID' },
      },
      required: ['post', 'parentType', 'parentId'],
    },
  },
  {
    name: 'search_notes',
    description: 'Search for notes/comments',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: { type: 'string' }, parentType: { type: 'string' }, parentId: { type: 'string' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },

  // ── Teams ─────────────────────────────────────────────
  {
    name: 'search_teams',
    description: 'Search for teams',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'get_team_members',
    description: 'Get all members of a team',
    inputSchema: {
      type: 'object',
      properties: { teamId: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['teamId'],
    },
  },
  {
    name: 'add_user_to_team',
    description: 'Add a user to a team',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' }, teamId: { type: 'string' }, position: { type: 'string' } },
      required: ['userId', 'teamId'],
    },
  },
  {
    name: 'remove_user_from_team',
    description: 'Remove a user from a team',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' }, teamId: { type: 'string' } },
      required: ['userId', 'teamId'],
    },
  },

  // ── Roles ─────────────────────────────────────────────
  {
    name: 'assign_role_to_user',
    description: 'Assign a role to a user',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' }, roleId: { type: 'string' } },
      required: ['userId', 'roleId'],
    },
  },

  // ── Users ─────────────────────────────────────────────
  {
    name: 'search_users',
    description: 'Search for users in the system',
    inputSchema: {
      type: 'object',
      properties: {
        userName: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' },
        emailAddress: { type: 'string' }, isActive: { type: 'boolean' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_user_by_email',
    description: 'Find a user by email address',
    inputSchema: {
      type: 'object',
      properties: { emailAddress: { type: 'string' } },
      required: ['emailAddress'],
    },
  },
  {
    name: 'get_user_teams',
    description: 'Get all teams a user belongs to',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
  },
  {
    name: 'get_user_permissions',
    description: 'Get effective permissions for a user',
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
  },

  // ── Generic Entities ──────────────────────────────────
  {
    name: 'create_entity',
    description: 'Create a record for any entity type',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', description: 'The entity type (e.g. Contact, Account)' },
        data: { type: 'object', description: 'Entity data as key-value pairs' },
      },
      required: ['entityType', 'data'],
    },
  },
  {
    name: 'search_entity',
    description: 'Search any entity type with flexible filters',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string' }, filters: { type: 'object' },
        limit: { type: 'number' }, offset: { type: 'number' },
        orderBy: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] },
      },
      required: ['entityType'],
    },
  },
  {
    name: 'get_entity',
    description: 'Get a specific entity record by ID',
    inputSchema: {
      type: 'object',
      properties: { entityType: { type: 'string' }, entityId: { type: 'string' } },
      required: ['entityType', 'entityId'],
    },
  },
  {
    name: 'update_entity',
    description: 'Update any entity record by ID',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string' }, entityId: { type: 'string' },
        data: { type: 'object', description: 'Updated data as key-value pairs' },
      },
      required: ['entityType', 'entityId', 'data'],
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete any entity record by ID',
    inputSchema: {
      type: 'object',
      properties: { entityType: { type: 'string' }, entityId: { type: 'string' } },
      required: ['entityType', 'entityId'],
    },
  },

  // ── Relationships ─────────────────────────────────────
  {
    name: 'link_entities',
    description: 'Create relationships between entities',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string' }, entityId: { type: 'string' },
        relationshipName: { type: 'string' },
        relatedEntityIds: { type: 'array', description: 'Array of related entity IDs' },
      },
      required: ['entityType', 'entityId', 'relationshipName', 'relatedEntityIds'],
    },
  },
  {
    name: 'unlink_entities',
    description: 'Remove relationships between entities',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string' }, entityId: { type: 'string' },
        relationshipName: { type: 'string' },
        relatedEntityIds: { type: 'array', description: 'Array of related entity IDs to unlink' },
      },
      required: ['entityType', 'entityId', 'relationshipName', 'relatedEntityIds'],
    },
  },
  {
    name: 'get_entity_relationships',
    description: 'Get all related entities for a specific relationship',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string' }, entityId: { type: 'string' },
        relationshipName: { type: 'string' },
        limit: { type: 'number' }, offset: { type: 'number' },
      },
      required: ['entityType', 'entityId', 'relationshipName'],
    },
  },

  // ── Health ────────────────────────────────────────────
  {
    name: 'health_check',
    description: 'Check EspoCRM connection and API status',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ── Web Fetching ─────────────────────────────────────
  {
    name: 'fetch_url',
    description: 'Fetch and extract text content from a public webpage URL. Useful for analyzing investor websites, company pages, portfolio listings, news articles, and other publicly accessible web content. Returns the extracted text from the page. Does not work with login-protected pages or JavaScript-heavy single-page applications.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch (must start with https:// or http://)' },
      },
      required: ['url'],
    },
  },

  // ── Email Drafting ────────────────────────────────────
  {
    name: 'draft_email',
    description: 'Generate an email draft for a CRM contact. Returns subject and body for user review — does NOT send the email.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'EspoCRM Contact ID' },
        purpose: { type: 'string', description: 'Purpose/context for the email (max 500 chars)' },
        tone: { type: 'string', description: 'Tone of the email', enum: ['formal', 'casual'] },
        keyPoints: { type: 'array', items: { type: 'string' }, description: 'Key points to include (1-10 items)' },
      },
      required: ['contactId', 'purpose', 'tone', 'keyPoints'],
    },
  },

  // ── Knowledge Base Management ─────────────────────────
  {
    name: 'list_knowledge',
    description: 'List all documents in the AI knowledge base. Shows global knowledge (shared company info like pitch deck, investment criteria) and personal knowledge (user-specific context like communication style, personal DNA). Use this when the user asks what the AI knows about them or their company.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_knowledge',
    description: 'Create or update a knowledge document in the AI knowledge base. Use this when the user wants to add, update, or replace information that the AI should always remember — such as company details, personal communication style, investment criteria, or any persistent context. The content is injected into every future AI conversation automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Where to store: "global" (shared across all users — company info, pitch deck) or "personal" (only for the current user — communication style, personal DNA)', enum: ['global', 'personal'] },
        filename: { type: 'string', description: 'Filename for the document (use kebab-case, e.g. "personal-dna", "investment-criteria"). Extension .md is added automatically.' },
        content: { type: 'string', description: 'The full markdown content to store. This replaces any existing content in the file.' },
      },
      required: ['scope', 'filename', 'content'],
    },
  },
  {
    name: 'delete_knowledge',
    description: 'Delete a knowledge document from the AI knowledge base. Use this when the user wants to remove outdated or incorrect persistent context.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Where the document is stored: "global" or "personal"', enum: ['global', 'personal'] },
        filename: { type: 'string', description: 'Filename to delete (with or without .md extension)' },
      },
      required: ['scope', 'filename'],
    },
  },
];
