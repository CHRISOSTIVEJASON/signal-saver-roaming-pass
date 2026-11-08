CREATE TABLE public.gn_captive_credentials (
 network_id text PRIMARY KEY REFERENCES public.gn_networks(id) ON DELETE CASCADE,
 config jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gn_captive_credentials TO authenticated;
GRANT ALL ON public.gn_captive_credentials TO service_role;
ALTER TABLE public.gn_captive_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_captive_credentials ON public.gn_captive_credentials FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
COMMENT ON TABLE public.gn_captive_credentials IS 'Private shared captive portal login configuration. Public network projections must never include credentials. Paid users obtain only their target network configuration through an authorized server function.';