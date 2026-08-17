const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config();

const app = express();