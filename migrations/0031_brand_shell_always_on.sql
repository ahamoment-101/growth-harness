update brand_shell_settings
set status = 'enabled',
    next_check_at = '',
    sync_lease_until = '',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where status != 'enabled';
