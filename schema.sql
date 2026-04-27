-- Run this in your Supabase SQL editor

CREATE TABLE verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  institution VARCHAR(255) NOT NULL,
  department VARCHAR(255),
  title VARCHAR(255),
  confidence FLOAT,
  verified BOOLEAN,
  status VARCHAR(50),
  sources JSONB,
  evidence JSONB,
  flags JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  ip_address INET
);

CREATE INDEX idx_name_inst ON verification_requests(name, institution);
CREATE INDEX idx_status ON verification_requests(status);
CREATE INDEX idx_expires ON verification_requests(expires_at);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(50),
  data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
