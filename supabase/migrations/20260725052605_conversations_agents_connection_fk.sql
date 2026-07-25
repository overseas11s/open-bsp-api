alter table "public"."conversations_agents" add column "organization_address" text not null;

CREATE INDEX conversations_agents_organization_address_idx ON public.conversations_agents USING btree (organization_id, organization_address);

alter table "public"."conversations_agents" add constraint "conversations_agents_organization_address_fkey" FOREIGN KEY (organization_id, organization_address) REFERENCES public.organizations_addresses(organization_id, address) ON DELETE CASCADE not valid;

alter table "public"."conversations_agents" validate constraint "conversations_agents_organization_address_fkey";


