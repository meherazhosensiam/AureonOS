prefix = get_option('prefix')

if prefix.startswith('/usr')
    apparmor_file = configure_file(input: 'desktop-icons-ng.in',
                                   output: 'desktop-icons-ng',
                                   configuration: {'PREFIX': prefix},
                                   install: true,
                                   install_dir: '/etc/apparmor.d')
endif