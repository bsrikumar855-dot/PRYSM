-- Local development only: runs once when the dev Postgres volume is first created.
-- Production roles and passwords are provisioned by infrastructure, never by migrations (TRACKING F-43).
-- Roles follow ADR-0007: runtime roles are not superusers, cannot bypass RLS, and own nothing.
CREATE ROLE prysm_owner LOGIN PASSWORD 'prysm-owner-dev-only' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB;
CREATE ROLE prysm_app LOGIN PASSWORD 'prysm-app-dev-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE prysm_platform LOGIN PASSWORD 'prysm-platform-dev-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE prysm_gateway_outbox LOGIN PASSWORD 'prysm-gateway-dev-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE DATABASE prysm OWNER prysm_owner;
\connect prysm
CREATE EXTENSION IF NOT EXISTS vector;
